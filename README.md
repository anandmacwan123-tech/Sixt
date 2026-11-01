# Atrium Light Tower

A real-time, ray-traced WebGL2 light installation. It's a tower of eight identical, softly lit
corridors, and each floor is coloured by one of the
[DepthVideo](https://github.com/anandmacwan123-tech/DepthVideo) colourways. A smooth depth sweep
travels through each room. You ride between floors through a luminous mist.

## Run it

There is no build step and no dependencies. Either:

- open `index.html` directly in a desktop browser, or
- serve the folder statically, for example `python3 -m http.server`. On Cloudflare Pages, leave
  the build command empty and set the output directory to `/`.

It needs WebGL2 with floating-point render targets, which current Chrome, Edge, Firefox and Safari
all have. The renderer lowers its internal resolution to hold the frame rate, and on slow GPUs it
switches to a cheaper reflection mode.

## Using it

The interface has no text and one fixed palette, whatever the system theme or the floor's colours:
white pills with hairline borders, grey icons that turn black when active, and a black outline
traced from the left (on sliders it shows the value: drag anywhere on the pill). A progressive
blur behind each edge keeps it legible. Everything stays hidden until the pointer reaches an edge. On touch
screens, tap the small handle on an edge instead.

- **Right edge**: the floors. Each pill shows that floor's gradient. You can also use `↑` / `↓`
  (or `PageUp` / `PageDown`), or swipe vertically on touch screens.
- **Bottom edge**: settings for the current floor:
  - light intensity, reflectiveness and atmosphere (haze)
  - the 15 DepthVideo colourways
  - three colour dots (light, middle, dark) that turn the floor into a custom gradient
  - depth sweep on or off
  - reset the floor (its objects stay)
  - insert an object (the cube with a plus)

Settings are saved per floor in the browser (`localStorage`).

## Interior objects

The insert button opens six blank shapes: sphere, block, cylinder, pill, ring and cone. Pick one
and it follows the pointer over the floor, walls and ceiling, standing on whatever surface is under
it (including other objects, so things can be stacked). Click to place it.

Objects have no texture: a neutral white material that takes its colour from the floor's light,
casts shadows, shows up in reflections and the GI, and is lit by the haze and the depth sweep.

Click an object to select it and drag it to move it. While it's selected, a bar above the tray sets:

- roughness, from polished (mirror-like coat) to chalky
- size and height (height stretches the shape into a plinth, a column, a disc...)
- turn around the surface it stands on
- duplicate (the copy follows the pointer until you place it) and delete

`Delete` removes the selected object and `Esc` deselects or cancels a placement. Each floor holds
up to 12 objects, and they're saved with the floor.

## The room

The room is deliberately simple: floor, ceiling and curved side panels turned towards the camera.
All inside corners are filleted (0.8 m), so no edge reads. The glowing lightbox at the end is the
only hard shape. A faint luminous ceiling and the hidden white light strips fill the room with
light. The strips sit in the grooves behind each wall panel, are only ever seen as reflected
light, and pulse.

## Colour

Each floor's colourway is turned into a gradient texture: light→dark and dark→light rows,
interpolated exactly as DepthVideo does it, OKLab for the designed maps and sRGB for the sampled
ones. The texture drives:

- the lightbox, which shows the light end of the gradient
- the paint, ceiling light and wall colour
- the depth sweep
- a final grade, which maps the image's tones through the gradient while keeping its brightness

## Depth sweep

The sweep is after DepthVideo's Depth Sweep, but uses the exact depth of the 3D scene instead of
an estimated depth map. A single, very wide raised-cosine wave (85 % of the corridor) travels from
the camera to the far end every 8 s. It's fully feathered, so there are no bands. It brightens and
recolours the surfaces it passes. Its glow in the haze is integrated analytically along each view
ray. It runs after temporal accumulation, so it stays smooth.

## How the lighting works

All rendering happens in fragment shaders (`js/shaders.js`). The scene is a signed distance field,
sphere-traced every frame.

- **End panel**: an area light with stochastic soft shadows.
- **Slits**: directional area lights.
- **Indirect light**: a multi-bounce irradiance probe volume per floor, ray traced on the GPU.
- **Reflections**: glossy ray-traced GGX reflections.
- **Haze**: single-scattering haze.
- **Objects**: extra distance-field shapes in the same scene, so every pass (shadows, reflections,
  GI probes) sees them. A bounding-sphere test keeps their cost near zero away from them.
- **Final image**: temporal accumulation, bloom and a hue-preserving filmic tone curve.

## Files

```
index.html        canvas, loader, floors rail and settings tray (icons only)
css/style.css     interface styles and edge reveal
js/shaders.js     all GLSL: scene, lights, GI probes, haze, TAA, depth sweep, bloom, grade
js/gl.js          WebGL2 helpers
js/renderer.js    pass orchestration, probe scheduling, camera framing
js/floors.js      DepthVideo colourways, gradient textures, colour derivation, persistence
js/scene.js       CPU copy of the distance field, for picking surfaces and objects
js/objects.js     inserting, placing, selecting, dragging and editing objects
js/app.js         elevator, edge-revealed controls, adaptive resolution, render loop
```

### Debug URL parameters

`?debug=1..7` shows albedo, normals, direct light, GI, reflections, AO or panel visibility.
`?scale=0.5` fixes the internal resolution. `?quality=low|high` forces a rendering path.
`?floor=3` sets the start floor. `?haze=0.8` and `?sweep=0` override floor settings.
`?time=2.5` freezes the clock. `?ui=1` shows both panels.
