// Barcode rendering for stickers. Product barcodes are EAN-13 (our own
// 200… numbers, or a GS1 GTIN once the company has one); batch stickers
// use Code 128, which carries letters (BAT-2026-000001).
import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

export function barcodeFormat(value: string): { format: string; text: string } {
  if (/^\d{13}$/.test(value)) return { format: 'EAN13', text: value };
  if (/^0\d{13}$/.test(value)) return { format: 'EAN13', text: value.slice(1) };   // GTIN-14 with a leading 0
  if (/^\d{12}$/.test(value)) return { format: 'UPC', text: value };
  if (/^\d{8}$/.test(value)) return { format: 'EAN8', text: value };
  return { format: 'CODE128', text: value };
}

// The barcode printed for an item: its GS1 GTIN if it has one, else our own number.
export const itemBarcode = (item: { barcode?: string | null; gtin?: string | null }) => item.gtin || item.barcode || '';

export function Barcode({ value, height = 50, className = '' }: { value: string; height?: number; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg || !value) return;
    const { format, text } = barcodeFormat(value);
    try {
      JsBarcode(svg, text, {
        format, height, width: 2, margin: format === 'CODE128' ? 6 : 10, marginTop: 4, marginBottom: 2,
        displayValue: true, fontSize: 16, textMargin: 1, font: 'ui-monospace, Menlo, monospace',
        background: '#ffffff', lineColor: '#000000', flat: format === 'CODE128',
      });
      // scale with the sticker instead of fixed pixels
      const w = svg.getAttribute('width'), h = svg.getAttribute('height');
      if (w && h) {
        svg.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
        svg.removeAttribute('width'); svg.removeAttribute('height');
      }
    } catch {
      svg.innerHTML = '';
    }
  }, [value, height]);
  return <svg ref={ref} className={`barcode ${className}`} role="img" aria-label={`Barcode ${value}`} />;
}
