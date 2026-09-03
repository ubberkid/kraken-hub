# The editor

The home screen is where you design what your Kraken shows. It is one screen:
your Kraken on the left, at the biggest size the window allows, and the list of
what is on it down the right. There are no tabs.

On first run, three starter Looks sit beside the halo.

## Layers

A **Look** is what your Kraken is showing. It is made of **layers**.

The bottom layer is the **base** — a video, an effect, a picture, a clock, a
stats face, a plain shape or a flat colour. It fills the panel, and there is
always exactly one of it. Pick it from the row of buttons at the bottom of the
rail; the rest of your layers stay exactly where they are when you change it,
and the settings of the one you switched away from are kept, so switching back
is not a way to lose them.

That row offers exactly the kinds that **can** be a background, and so does the
Background row in **+ Add a layer** — they are one list, read off each module's
own declaration of where it may sit. Text, an icon and a date are overlays only,
so they are in neither.

In a short window — CAM's own is 866×537 — the chips get smaller rather than
fewer: they wrap onto two lines, all seven of them on the screen at once, and
the layer list still shows four whole rows under them. They used to be one line
that scrolled sideways, which fitted the same seven backgrounds into a 221 px
column by putting three of them past its right edge, with no fade to say so and
a mouse wheel that did nothing over them.

The **BASE** label beside the chips is the other door to the same seven: press
it and **+ Add a layer** opens at its Background row, every background as a
tile with its own description. Nothing about choosing a background needs a
sideways gesture.

Everything above the base is an **overlay** — a clock over your video, a line of
text, a temperature strip along the bottom. Press **+ Add a layer**, pick one,
and it lands in the first free space on the panel rather than on top of whatever
is already there. It is selected the moment it arrives.

"First free space" means free **and on the glass**. The panel is a circle, so
the room at the bottom of it is much narrower than the room across the middle: a
wide overlay placed low is moved up rather than left hanging off both sides. And
if nothing at the layer's own size fits anywhere, it arrives **smaller** rather
than on top of something — the largest size that does fit, down to the smallest
the app will hold. The kind's own idea of where it goes is honoured exactly on
an empty panel, bleed and all; once there is something else there, a new layer
is being fitted in, and it fits.

The rail reads front to back, the way you see the panel. Drag a row to change
what is in front, or use the two small arrows on it. The eye hides a layer
without deleting it — a hidden layer costs the panel nothing and keeps all its
settings. Double-click a name to rename it.

The padlock beside the eye **locks** a layer. A locked layer is still on the
panel and still in the list — you can **select** it, hide it, rename it, restack
it and delete it — but the halo will not pick it up: clicks pass straight through
to whatever is underneath, its size and opacity controls are greyed with the
reason beside them (_"That layer is locked. Unlock it in the list to move it."_),
and a marquee or **⌘A** leaves it out. Selecting is deliberately not refused:
the layer's own inspector, which is one of the two places its lock can be
undone, would otherwise be locked behind the lock. It is for the background photo you have finished placing
and would rather stop nudging by accident. Locking is an undo step like any
other, and the lock travels with the Look, so a layer locked here is locked on
your phone too.

A Look holds up to eight layers, and the rail counts them out loud before you
get there: at seven it reads **7 of 8 layers**, and at eight it says _"This look
is full — eight layers is the most that fits on the wire."_ The limit is a size
limit on what travels to the panel, not a performance one — how heavy a Look is
is the meter's question, not this one — and it is on the screen rather than in a
tooltip on a greyed-out button, because a tooltip is invisible on a touch screen
and to anybody using a keyboard.

## Moving things

Drag a layer on the halo to move it. Drag a corner to resize it. Drag the
lollipop above it to rotate.

While you drag, a small readout follows the gesture: **x 26 · y −435 · 100% ·
0°** — pixels from the centre of the panel, size as a percentage of the layer's
natural size, and the rotation. All four, on every gesture, because lining two
layers up usually needs the number that is not attached to the handle you happen
to be holding.

While you are dragging, guides appear: the centre lines, the safe ring your
bezel does not cover, the clock positions, and the edges of your other layers.
Drag near the middle and the layer lands exactly in the middle. Rotate near a
quarter-turn and it lands exactly on it. Hold **Alt** (or **⌘**) while dragging
to turn all of that off and place something by eye.

From the keyboard, with a layer selected:

| Key                 | What it does                             |
| ------------------- | ---------------------------------------- |
| Arrows              | Nudge one panel pixel. **Shift** for ten |
| **Esc**             | Put the selection down                   |
| **Delete**          | Remove the layer                         |
| **⌘D** / **Ctrl-D** | Duplicate it                             |
| **[** and **]**     | Send back / bring forward                |
| **⌘A** / **Ctrl-A** | Select every overlay                     |
| **⌘Z** / **Ctrl-Z** | Undo                                     |
| **⇧⌘Z**             | Redo                                     |

A nudge is one pixel **of the panel**, not one pixel of the window: the same
press moves a layer the same distance on your Kraken whether the CAM window is
wide or narrow.

If a layer is far enough off-centre that your Kraken's bezel would cut it, the
selection box says so. It does not stop you — a photo bleeding to the edge is
often exactly what you want.

## Several at once

Shift-click a row or a layer on the halo to add it to the selection, drag a box
on empty space to sweep several up, or press **⌘A** for all of them. Each one
gets its own outline and the group gets a box around the lot, with the same
corner handles and lollipop: dragging inside the group moves everything, a
corner scales it about its centre, and the lollipop turns it. Locked layers stay
out of it.

With two or more selected, the strip becomes the group's: six alignments, a
choice of what to align **to** — the canvas, or the selection's own box — and
distribute, which evens the gaps between three or more and leaves the two ends
where they are. Every one of them is a single undo step, however many layers
moved.

## The strip

Selecting a layer shows a row of controls under the halo: that layer's three to
five most useful settings, and **More**. Nothing else on the screen changes.

Every kind declares its own strip, so a clock shows face, 12/24, seconds and
colour, and a video shows source, fit, loop and quality. A choice with more
options than fits — a stats face, a font — scrolls sideways inside the strip
rather than growing a second and third row: the strip floats over the bottom of
the halo, and a tall one would cover the thing it is a caption for.

The row that scrolls stops short of the right edge, and **More** sits outside
it, pinned. A row that scrolls fades at whichever end it is cutting something
off, so a strip that ends mid-control reads as a strip with more in it rather
than as a control that stopped. Tab moves through the controls and brings each
one into view as it goes; a mouse wheel over the row moves it sideways.

## More, and the inspector

**More** opens the **inspector**: everything about the selected layer, in the
rail's column, beside the halo rather than on top of it. The halo does not
shrink to make room for it.

The strip's other doors — **Effect**, **Preset**, **Colours** — open the same
inspector, scrolled to the layer's own settings, because that is the thing you
asked for. **More** opens it at the top, because **More** asks for the sheet
rather than for anything in it.

It has four parts:

- **Layout** — x, y, size, rotation and opacity as numbers you can type, in the
  units they are actually measured in: **X and Y in panel pixels from the
  centre**, size and opacity as a **percentage**, rotation in **degrees**. The
  Look file itself stores position as a fraction of the panel — that is what
  makes one Look fit a 640 px Elite and a 240 px square — and the conversion
  happens at this field rather than in the document. The numbers go through
  exactly the same clamps a drag does, so nothing you type here can put a layer
  somewhere a drag could not, and the drag's own readout uses the same units.
- **The layer's own settings** — the full panel for that kind, the same one the
  module ships.
- **Visibility** — on the panel or hidden, locked or unlocked.
- **Advanced** — what this layer is, and where its settings travel.

**Esc** closes it. Every strip action that needs more than a row — colours,
presets, the effect catalogue, the quality ladder — opens this one place rather
than four buttons that all led to the same wall.

### On a phone

The same sheet, with the same four parts, from the same strip. It opens as a
sheet under the canvas instead of in the rail's column, at 44 px controls, and
it scrolls inside itself so the canvas never moves; **Done** or **Esc** closes
it. See [Editing from your phone](remote-control.md#editing-from-your-phone) for
what the phone keeps and the one thing it does not (files — import, export and
the media library are the PC's).

Touch is decided by the **pointer**, not by the window's width. A tablet, or a
phone whose window is wider than 700 px, gets the full editor _with_ the touch
behaviour: 44 px handles, pinch to scale, two fingers to rotate, and a long
press for duplicate / front / back / remove. It used to key on the width
breakpoint, so making the window bigger to reach the inspector cost you every
gesture on the way.

## Undo

Undo is everywhere and it is cheap. Fifty steps, from the buttons in the header
or from the keyboard, anywhere on the page. A whole drag is one step — undoing
puts the layer back where your finger went down, not at the frame before the
last one.

Undo also crosses a change made somewhere else. If your phone or a second CAM
window moves something, that lands in your undo stack like any other change,
because it is what actually happened to the panel.

## The budget meter

The bar in the header is what this Look costs your Kraken.

It has two voices, and it tells you which one it is using.

- Once your Kraken has reported a frame rate, the meter is a **reading**:
  _Keeping up_, or _Falling behind_.
- Before that — a window that has never seen a Kraken, or one that has not heard
  from it lately — the meter is an **Estimate**, added up from what each kind of
  layer says it costs. Nothing on this page can see how hard CAM's own capture is
  working, which is where a busy Look actually gets expensive, so the word is on
  the bar and the full sentence is in its tooltip.

Either way there is a bar and a number: a frame rate when one has been
reported, and the percentage of the budget when one has not. It never prints a
dash — if it cannot measure, it says what it can add up, and says that is what
it did.

**What the bar is a fraction OF** is the panel's headroom, not a layer count.
The two marks on it are the frame governor's own: the bar is in the calm range
until the point where the governor would start watching, amber between there and
the point where it drops a Look to a coarser tier, and red past it. So a video
background — the commonest Look in the product — reads about **60 %** and calm; a
clock on a flat ground reads **0 %**, because a clock that ticks once a second
genuinely costs the panel nothing; and a Look heavy enough to be reduced reads
past **90 %** in red. The colour is never the only signal: the word beside the
bar and the number both say the same thing.

When a Look is heavy the meter names the layer costing the most, in the tooltip
and in the rail. That name is always an estimate, even when the frame rate above
it is a reading — nothing on the wire times a single layer — so it says so.
It is a suggestion, never a block: nothing here refuses a Look you asked for.

## Motion

Nothing on this screen cuts. A layer fades and scales in when you add it, fades
out before it goes, and switching the background cross-fades the halo through
and back. If your system asks for less movement, all three simply happen at
once — the change still happens, it just does not travel.

## What is not here yet

- **Audio layers.** _Track_, _Album art_ and _Visualizer_ are listed in the add
  sheet and greyed out, with the reason on them: they need an audio companion
  that does not ship yet. They are shown rather than hidden so you can see what
  the gap is.
- **Look bundles.** A Look exports as a `.krakenlook` — the layout and the
  settings, with pictures and clips named rather than carried. The bundle that
  packs the media in with it (`.krakenlook.zip`) is not written yet, so a Look
  you send someone finds its media in their library or shows an honest card.
- **A picture of the face.** There is no "save a PNG of what the panel is
  showing" button yet.
