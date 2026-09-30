import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { getQrDisplaySource } from './qr-display';

/** Shared renderer for both providers, including Evolution image and raw WAHA QR formats. */
export function ChannelQrView({ qrCode, expiresAt, provider }: { qrCode?: string; expiresAt?: string; provider: string }) {
  const source = useMemo(() => getQrDisplaySource(qrCode), [qrCode]);
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false; setGenerated(null); setError(false);
    if (source?.kind === 'payload') void QRCode.toDataURL(source.payload, { errorCorrectionLevel: 'M', margin: 3, scale: 9, color: { dark: '#13291f', light: '#ffffff' } })
      .then((data) => { if (!cancelled) setGenerated(data); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [source]);
  const expired = expiresAt && Date.parse(expiresAt) <= now;
  const image = source?.kind === 'image' ? source.src : generated;
  return <div className="qr-box" aria-label={`QR Code ${provider}`}>
    {expired ? <span>QR expirado — gere outro QR Code.</span> : image ? <img className="qr-image" alt={`QR Code ${provider} para conectar o WhatsApp`} src={image} /> : <span>{error ? 'Não foi possível renderizar o QR recebido.' : qrCode ? 'Gerando QR visível...' : 'Gere o QR Code para esta conexão.'}</span>}
  </div>;
}
