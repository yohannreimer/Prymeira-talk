import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { readPairingQr } from './qr-display';

/** Both providers share the same validation, expiry and scanning instruction gate. */
export function ChannelQrView({ qrCode, expiresAt, provider, children }: {
  qrCode?: string; expiresAt?: string; provider: string; children?: (ready: boolean) => ReactNode;
}) {
  const identity = JSON.stringify([provider, qrCode, expiresAt]);
  const [result, setResult] = useState<{ identity: string; image: string | null } | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const payload = await readPairingQr(qrCode, controller.signal);
        if (controller.signal.aborted) return;
        const image = payload ? await QRCode.toDataURL(payload, {
          errorCorrectionLevel: 'M', margin: 3, scale: 9, color: { dark: '#000000', light: '#ffffff' }
        }) : null;
        if (!controller.signal.aborted) setResult({ identity, image });
      } catch { if (!controller.signal.aborted) setResult({ identity, image: null }); }
    })();
    return () => controller.abort();
  }, [identity, qrCode]);
  const expires = expiresAt ? Date.parse(expiresAt) : NaN;
  const expired = !!expiresAt && (!Number.isFinite(expires) || expires <= Math.max(now, Date.now()));
  // Checking identity during render prevents even one frame of the previous QR.
  const current = result?.identity === identity ? result : null;
  const image = !expired ? current?.image : null;
  const ready = !!image;
  return <>
    <div className="qr-box" aria-label={`QR Code ${provider}`} aria-busy={!expired && !current}>
      {expired ? <span>QR expirado — gere outro QR Code.</span> : image ? <img className="qr-image" alt={`QR Code ${provider} para conectar o WhatsApp`} src={image} />
        : <span role="status">{!qrCode ? 'Gere o QR Code para esta conexão.' : current ? 'O provedor ainda não enviou um QR válido do WhatsApp. Aguarde a atualização ou gere outro código.' : 'Aguarde, preparando e verificando o QR Code. Ainda não escaneie.'}</span>}
    </div>
    {children?.(ready)}
  </>;
}
