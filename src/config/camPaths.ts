/**
 * The two places in CAM a user is ever sent, written once.
 *
 * Round 2's R6 counted the variants shipping side by side: *"Lighting → Kraken
 * → Web Integration → Frame Rate"*, *"Web Integration → Frame Rate"*, *"CAM →
 * Lighting → your Kraken → Mode: Web Integration → Frame Rate"*, *"CAM →
 * Kraken → Configure"*, *"CAM → Lighting → Kraken → Configure"* — five spellings
 * of two destinations, across the display's error cards, the config UI, the
 * validators and the docs. A user following one of them and finding a menu
 * whose words do not match concludes the instruction is stale.
 *
 * So there are exactly two constants, and every surface imports them. They are
 * written the way CAM's own menus read, including the possessive **your**
 * Kraken — the one in the machine, not a product category.
 *
 * This file is deliberately dependency-free and lives outside `src/ui` and
 * `src/app/config`, because the display graph needs it too (invariant I8, and
 * `budgets.json`'s `displayGraph.forbidden` list).
 */

/** Where CAM's frame-rate slider lives. It ships at 1 FPS; nothing else matters until it is raised. */
export const CAM_PATH_FRAME_RATE = 'CAM → Lighting → your Kraken → Web Integration → Frame Rate';

/** Where the configuration browser for this card is opened from. */
export const CAM_PATH_CONFIGURE = 'CAM → Lighting → your Kraken → your kraken-hub card → Configure';
