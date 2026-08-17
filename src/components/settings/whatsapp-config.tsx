'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';

type Status = {
  connected: boolean;
  name: string;
  profileName: string;
  owner?: string;
};

export function WhatsAppConfig() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [instanceToken, setInstanceToken] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect');
      const data = await res.json();
      setStatus(data);
    } catch {
      toast.error('Failed to load WhatsApp connection status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll for connection while a QR code is on screen — the user scans
  // it out-of-band, so there's no client-side event to react to.
  useEffect(() => {
    if (!qrcode) return;
    const interval = setInterval(async () => {
      const res = await fetch('/api/whatsapp/uazapi/connect');
      const data = await res.json();
      if (data.connected) {
        setStatus(data);
        setQrcode(null);
        toast.success('WhatsApp connected');
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [qrcode]);

  const handleConnect = async () => {
    if (!instanceToken) {
      toast.error('Instance token is required');
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_token: instanceToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect');
        return;
      }
      if (data.connected) {
        setStatus(data);
        toast.success('WhatsApp connected');
      } else if (data.qrcode) {
        setQrcode(data.qrcode);
      }
    } catch {
      toast.error('Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">WhatsApp</CardTitle>
        <CardDescription className="text-muted-foreground">
          Connect a UAZAPI instance to send and receive WhatsApp messages.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status?.connected ? (
          <div className="flex items-center gap-2 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Connected as {status.profileName || status.name}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" />
            Not connected
          </div>
        )}

        {!status?.connected && canEditSettings && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="instance-token" className="text-muted-foreground">
                Instance token
              </Label>
              <Input
                id="instance-token"
                value={instanceToken}
                onChange={(e) => setInstanceToken(e.target.value)}
                placeholder="UAZAPI instance token"
                className="border-border bg-muted text-foreground"
              />
            </div>
            <Button onClick={handleConnect} disabled={connecting} className="w-fit">
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        )}

        {qrcode && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">Scan this QR code with WhatsApp</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrcode} alt="WhatsApp QR code" className="h-48 w-48" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
