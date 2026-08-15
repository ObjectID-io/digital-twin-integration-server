import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function TwinQrCode({ value }) {
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    let active = true;
    setImageUrl("");
    if (!value) return () => { active = false; };

    QRCode.toDataURL(value, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#07100f", light: "#ffffff" },
    }).then((url) => active && setImageUrl(url)).catch(() => active && setImageUrl(""));

    return () => { active = false; };
  }, [value]);

  if (!value) return null;
  return <section className="twin-qr" aria-labelledby="twin-qr-title">
    <div>
      <small>PUBLIC DIGITAL TWIN</small>
      <h3 id="twin-qr-title">Scan to open details</h3>
      <p>This link exposes only public on-chain Twin data. Login is not required.</p>
      <a href={value} target="_blank" rel="noreferrer">{value}</a>
    </div>
    {imageUrl
      ? <img src={imageUrl} width="280" height="280" alt="QR code linking to the public Digital Twin details" />
      : <span className="twin-qr-loading">GENERATING QR…</span>}
  </section>;
}
