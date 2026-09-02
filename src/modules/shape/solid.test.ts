import { describe, expect, it } from 'vitest';

import { NO_PAINT, SHAPE_DEFAULTS, SOLID_BASE_CFG, validateShape } from './schema';
import { shapeMarkup } from './svg';

/**
 * The **solid base** of `design-editor-ux.md` §10.
 *
 * The kind was already base-capable; what §10 asks for is a flat GROUND, and
 * the module's own defaults are not one — they are a translucent, rounded scrim
 * meant for an overlay band. `SOLID_BASE_CFG` is the config that makes the same
 * kind the ground, and these are the four things a template or the add sheet is
 * relying on when it uses it.
 */
describe('SOLID_BASE_CFG', () => {
  it('is a valid config, and survives its own validator unchanged', () => {
    expect(validateShape(SOLID_BASE_CFG)).toEqual(SOLID_BASE_CFG);
    expect(validateShape(validateShape(SOLID_BASE_CFG))).toEqual(SOLID_BASE_CFG);
  });

  it('is opaque, unstroked and square-cornered — the four things "solid" means', () => {
    expect(SOLID_BASE_CFG.shape).toBe('rect');
    expect(SOLID_BASE_CFG.fillOpacity).toBe(1);
    expect(SOLID_BASE_CFG.stroke).toBe(NO_PAINT);
    expect(SOLID_BASE_CFG.radius).toBe(0);
  });

  it('is not the module defaults, which are a scrim', () => {
    // If these ever converge, one of the two is wrong: the default overlay is a
    // translucent band and the base is a ground.
    expect(SOLID_BASE_CFG).not.toEqual(SHAPE_DEFAULTS);
  });

  it('paints edge to edge on a panel-sized box', () => {
    const markup = shapeMarkup(SOLID_BASE_CFG, { w: 640, h: 640 });
    expect(markup).toContain('<rect x="0.00" y="0.00" width="640.00" height="640.00"');
    expect(markup).toContain('rx="0.00"');
    expect(markup).toContain(`fill="${SOLID_BASE_CFG.fill}"`);
    expect(markup).toContain('fill-opacity="1.00"');
    expect(markup).not.toContain('stroke=');
  });
});
