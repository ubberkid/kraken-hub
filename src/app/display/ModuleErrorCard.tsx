/**
 * The one thing a user can see when a module fails on a device with no input.
 *
 * Low entropy on purpose: flat black, a few large glyphs, no gradients and no
 * animation, so CAM's frame compressor has almost nothing to encode. The footer
 * is fixed text because it is the only actionable instruction that exists on a
 * screen you cannot click.
 */
export function ModuleErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="kh-overlay kh-error">
      <div className="kh-card">
        <p className="kh-card__title">{title}</p>
        <p className="kh-card__body">{detail}</p>
        <p className="kh-card__footer">Fix in CAM → Kraken → Configure</p>
      </div>
    </div>
  );
}
