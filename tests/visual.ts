import assert from "node:assert/strict"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { chromium } from "playwright"
import { PNG } from "pngjs"
import { Resvg } from "@resvg/resvg-js"
import { createCanvas } from "@napi-rs/canvas"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import { drawPcbCopperPour } from "circuit-to-canvas/lib/drawer/elements/pcb-copper-pour"
import { DEFAULT_PCB_COLOR_MAP } from "circuit-to-canvas/lib/drawer/types"
import pixelmatch from "pixelmatch"
import { featureSnapshot } from "./parity/snapshot"
import { prepareComparison } from "./parity/prepare"
import { compose, scale, translate } from "transformation-matrix"
import type { CircuitJson } from "../lib"
import pcbBendFixture from "./fixtures/pcb-bend.circuit.json"

const root = fileURLToPath(new URL("../", import.meta.url))
const server = await createServer({
  root,
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    watch: { ignored: ["**/*"] },
  },
  logLevel: "error",
})
await server.listen()
let browser
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      ...(process.env.WEBGPU_SOFTWARE
        ? [
            "--enable-gpu",
            "--use-angle=swiftshader",
            "--use-vulkan=swiftshader",
            "--enable-features=Vulkan",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ]
        : []),
    ],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  })
  const page = await browser.newPage({
    viewport: { width: 900, height: 800 },
    deviceScaleFactor: 1,
  })
  const errors: string[] = []
  page.on("pageerror", (e) => {
    errors.push(e.message)
    console.error(e.message)
  })
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text())
      console.error(m.text())
    }
  })
  await page.goto(server.resolvedUrls!.local[0])
  await page.waitForFunction(() => window.gpuTest, null, { timeout: 30000 })
  const visibility = await page.evaluate(() =>
    window.gpuTest.checkBoardVisibility(),
  )
  const pixel = (png: string, x: number, y: number) => {
    const image = PNG.sync.read(Buffer.from(png, "base64"))
    return [
      ...image.data.subarray(
        (y * image.width + x) * 4,
        (y * image.width + x) * 4 + 4,
      ),
    ]
  }
  const circleFrames = await page.evaluate(async () => {
    const modulePath = "/lib/index.ts"
    const { CircuitToWebGpuDrawer } = (await import(
      modulePath
    )) as typeof import("../lib")
    const frames = []
    for (const sampleCount of [1, 4] as const) {
      for (const opacity of [1, 0.5]) {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 64
        const drawer = await CircuitToWebGpuDrawer.create(canvas, {
          sampleCount,
          layerColors: { top_silkscreen: [1, 1, 1, opacity] },
        })
        try {
          for (const radius of [0.1, 0.5, 10]) {
            drawer.setCircuitJson([
              {
                type: "pcb_silkscreen_circle",
                pcb_silkscreen_circle_id: "thin-circle",
                pcb_component_id: "component",
                layer: "top",
                center: { x: 0, y: 0 },
                radius,
                stroke_width: 0.05,
              },
            ])
            for (const phase of [0, 0.25, 0.5]) {
              drawer.render({
                transform: {
                  a: 1,
                  b: 0,
                  c: 0,
                  d: -1,
                  e: 32 + phase,
                  f: 32 + phase,
                },
                background: [0, 0, 0, 1],
              })
              frames.push({
                radius,
                opacity,
                sampleCount,
                phase,
                png: canvas.toDataURL("image/png").split(",")[1],
              })
            }
          }
        } finally {
          drawer.dispose()
        }
      }
    }
    return frames
  })
  for (const { png, radius, opacity, sampleCount, phase } of circleFrames) {
    const image = PNG.sync.read(Buffer.from(png, "base64"))
    let coverage = 0
    for (let i = 0; i < image.data.length; i += 4)
      coverage += image.data[i] / 255
    const expected = 2 * Math.PI * radius * 0.05 * opacity
    // Allow RGBA8 rounding in the few pixels touched by a subpixel circle. The
    // larger control also allows the polygon/linear-distance approximation.
    const tolerance = radius < 1 ? 3 / 255 : expected * 0.05
    assert(
      Math.abs(coverage - expected) <= tolerance,
      `Circle coverage ${coverage}, expected ${expected}; radius=${radius}, opacity=${opacity}, samples=${sampleCount}, phase=${phase}`,
    )
  }
  console.log(`${circleFrames.length} thin-circle coverage/opacity checks`)
  const fabrication = await page.evaluate(() => {
    const drawer = window.gpuTest.drawer
    const canvas = document.querySelector("canvas")!
    const frames: Record<string, string> = {}
    for (const layer of ["top", "bottom"] as const) {
      const path = {
        type: "pcb_fabrication_note_path" as const,
        pcb_fabrication_note_path_id: "filled-region",
        pcb_component_id: "component",
        layer,
        route: [
          { x: 0, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 8 },
          { x: 0, y: 8 },
        ],
        stroke_width: 2,
        is_filled: true,
        has_stroke: false,
        color: "rgba(255,0,0,0.5)",
      }
      drawer.drawElements([path], {
        transform: { a: 10, b: 0, c: 0, d: -10, e: 20, f: 100 },
        selectedLayer: layer,
        showFabricationNotes: true,
        background: [0, 0, 0, 0],
      })
      frames[layer] = canvas.toDataURL("image/png").split(",")[1]
      drawer.render({ showFabricationNotes: false })
      frames[`${layer}-hidden`] = canvas.toDataURL("image/png").split(",")[1]
      drawer.render({
        showFabricationNotes: true,
        transform: { a: -10, b: 0, c: 0, d: -10, e: 100, f: 100 },
      })
      frames[`${layer}-mirrored`] = canvas.toDataURL("image/png").split(",")[1]
    }
    return frames
  })
  for (const layer of ["top", "bottom"]) {
    const inside = pixel(fabrication[layer], 40, 80)
    assert.equal(inside[0], 255)
    assert(Math.abs(inside[3] - 128) <= 1, "Fabrication fill preserves alpha")
    assert.equal(
      pixel(fabrication[layer], 80, 40)[3],
      0,
      "Concave notch stays empty",
    )
    assert.equal(
      pixel(fabrication[layer], 15, 80)[3],
      0,
      "Fill has no invented outline",
    )
    assert.equal(pixel(fabrication[`${layer}-hidden`], 40, 80)[3], 0)
    assert(
      Math.abs(pixel(fabrication[`${layer}-mirrored`], 80, 80)[3] - 128) <= 1,
    )
    assert.equal(pixel(fabrication[`${layer}-mirrored`], 40, 40)[3], 0)
  }
  const overlaps = await page.evaluate(() => {
    const frames: Record<string, string> = {}
    for (const layer of ["top", "bottom"] as const) {
      for (const filled of [false, true]) {
        window.gpuTest.drawer.drawElements(
          [
            {
              type: "pcb_fabrication_note_path",
              pcb_fabrication_note_path_id: "overlap",
              pcb_component_id: "component",
              layer,
              route: [
                { x: 2, y: 2 },
                { x: 8, y: 2 },
                { x: 8, y: 8 },
                { x: 2, y: 2 },
                { x: 8, y: 8 },
              ],
              stroke_width: 1,
              color: "rgba(255,0,0,0.5)",
              is_filled: filled,
            },
          ],
          {
            transform: { a: 10, b: 0, c: 0, d: 10, e: 0, f: 0 },
            selectedLayer: layer,
            showFabricationNotes: true,
            background: [0, 0, 0, 0],
          },
        )
        frames[`${layer}-${filled}`] = document
          .querySelector("canvas")!
          .toDataURL("image/png")
          .split(",")[1]
      }
    }
    return frames
  })
  for (const frame of Object.values(overlaps)) {
    for (const [x, y] of [
      [50, 20],
      [80, 20],
      [50, 50],
      [20, 20],
    ]) {
      const rgba = pixel(frame, x, y)
      assert.equal(rgba[0], 255)
      assert(
        Math.abs(rgba[3] - 128) <= 1,
        "Fabrication overlap must apply alpha once",
      )
    }
  }
  const translatedPathOrigin = {
    x: -11.299999199999984,
    y: 0.4999999999999997,
  }
  const translatedPaths = await page.evaluate(
    ({ origin, transform }) => {
      const frames: string[] = []
      const { x, y } = origin
      for (const layer of ["top", "bottom"] as const) {
        window.gpuTest.drawer.drawElements(
          [
            {
              type: "pcb_fabrication_note_path",
              pcb_fabrication_note_path_id: "translated-retrace",
              pcb_component_id: "component",
              layer,
              route: [
                { x, y },
                { x: x + 1, y: y + 0.000001 },
                { x, y },
              ],
              stroke_width: 0.254,
              color: "rgba(255,0,0,0.5)",
            },
          ],
          {
            transform,
            selectedLayer: layer,
            showFabricationNotes: true,
            background: [0, 0, 0, 0],
          },
        )
        if (window.gpuTest.drawer.diagnostics.length)
          throw new Error(JSON.stringify(window.gpuTest.drawer.diagnostics))
        frames.push(
          document
            .querySelector("canvas")!
            .toDataURL("image/png")
            .split(",")[1],
        )
      }
      return frames
    },
    {
      origin: translatedPathOrigin,
      transform: compose(
        translate(50, 50),
        scale(100, 100),
        translate(-translatedPathOrigin.x, -translatedPathOrigin.y),
      ),
    },
  )
  for (const frame of translatedPaths) {
    for (const x of [45, 50, 100, 155]) {
      const rgba = pixel(frame, x, 50)
      assert.equal(rgba[0], 255)
      assert(
        Math.abs(rgba[3] - 128) <= 1,
        "Translated retraced caps preserve alpha",
      )
    }
    assert.equal(pixel(frame, 100, 70)[3], 0, "Stroke width stays unchanged")
  }
  const pours = await page.evaluate(() =>
    window.gpuTest.checkCopperPourOpacity(),
  )
  const pourAlpha = (name: string, x: number) =>
    pixel(pours.frames[name], x, 110)[3]
  assert.equal(pourAlpha("aboveOne", 50), 255)
  assert.equal(pourAlpha("aboveOne", 110), 102)
  assert.equal(pourAlpha("aboveOne", 170), 102)
  for (const name of [
    "default",
    "half",
    "nan",
    "retained",
    "shown",
    "independent",
  ]) {
    assert(Math.abs(pourAlpha(name, 50) - 128) <= 1)
    assert(Math.abs(pourAlpha(name, 110) - 51) <= 1)
    assert(Math.abs(pourAlpha(name, 170) - 51) <= 1)
  }
  for (const background of ["black", "white"] as const) {
    const referenceCanvas = createCanvas(200, 200)
    const ctx = referenceCanvas.getContext("2d")
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 200, 200)
    for (const pour of pours.elements) {
      if (pour.type !== "pcb_copper_pour") continue
      drawPcbCopperPour({
        ctx,
        pour,
        realToCanvasMat: { a: 10, b: 0, c: 0, d: -10, e: 100, f: 100 },
        colorMap: DEFAULT_PCB_COLOR_MAP,
      })
    }
    const canvasReference = referenceCanvas
      .toBuffer("image/png")
      .toString("base64")
    for (const x of [50, 110, 170]) {
      const actual = pixel(pours.frames[background], x, 110)
      const expected = pixel(canvasReference, x, 110)
      assert(
        actual.every((channel, i) => Math.abs(channel - expected[i]) <= 1),
        `Default pour color must match Canvas on ${background}: ${actual} vs ${expected}`,
      )
    }
    const svg = convertCircuitJsonToPcbSvg([...pours.elements], {
      width: 200,
      height: 200,
      viewport: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
      backgroundColor: background,
      showSolderMask: false,
      shouldDrawErrors: false,
      shouldDrawRatsNest: false,
      includeVersion: false,
      drawPaddingOutsideBoard: false,
    })
    const reference = new Resvg(svg).render().asPng().toString("base64")
    // SVG uses a different inner-layer palette; top and bottom match both references.
    for (const x of [50, 110]) {
      const actual = pixel(pours.frames[background], x, 110)
      const expected = pixel(reference, x, 110)
      assert(
        actual.every((channel, i) => Math.abs(channel - expected[i]) <= 1),
        `Default pour color must match SVG on ${background}: ${actual} vs ${expected}`,
      )
    }
  }
  for (const name of ["zero", "negative", "hidden", "xrayHidden"])
    for (const x of [50, 110, 170]) assert.equal(pourAlpha(name, x), 0)
  for (const name of ["half", "zero", "hidden"]) {
    assert.equal(
      pixel(pours.frames[name], 40, 100)[3],
      255,
      "Pads must stay opaque",
    )
    assert.equal(
      pixel(pours.frames[name], 100, 50)[3],
      255,
      "Traces must stay opaque",
    )
  }
  assert.equal(pourAlpha("xray", 50), 255, "Selected X-Ray copper stays opaque")
  assert.equal(pours.geometryUploads, 1, "Opacity changes must reuse geometry")
  const xray = await page.evaluate(() => window.gpuTest.checkXRay())
  const layerColors = {
    top: [200, 52, 52, 255],
    inner1: [127, 200, 127, 255],
    bottom: [77, 127, 196, 255],
  }
  for (const [layer, color] of Object.entries(layerColors)) {
    assert.deepEqual(
      pixel(xray.frames[layer], 100, 100),
      color,
      `X-Ray must keep ${layer} in front at the overlap`,
    )
    for (const x of [40, 100, 160])
      assert.equal(pixel(xray.frames[layer], x, 50)[3], 255)
    assert.equal(pixel(xray.frames[layer], 100, 150)[3], 0)
  }
  for (const x of [40, 80, 120, 160]) {
    assert(pixel(xray.frames.before, x, 20)[3] > 0)
    assert.equal(
      pixel(xray.frames.dimmed, x, 20)[3],
      0,
      "Non-copper layers must be transparent during X-Ray",
    )
    assert.equal(
      pixel(xray.frames.exit, x, 20)[3],
      pixel(xray.frames.before, x, 20)[3],
      "Non-copper layers must return after X-Ray",
    )
  }
  for (const x of [40, 160]) {
    for (const frame of ["top", "dimmed", "fivePercent"])
      assert.deepEqual(
        pixel(xray.frames[frame], x, 130),
        [255, 38, 226, 255],
        "Selected drills must stay opaque",
      )
    assert.equal(
      pixel(xray.frames.dimmed, x, 170)[3],
      0,
      "Unrelated drills stay hidden",
    )
    assert.equal(
      pixel(xray.frames.changed, x, 130)[3],
      0,
      "Changing the net hides its old drills",
    )
    assert.equal(
      pixel(xray.frames.filtered, x, 130)[3],
      0,
      "Explicit layer filters can hide drills",
    )
    assert.deepEqual(
      pixel(xray.frames.exit, x, 170),
      [255, 38, 226, 255],
      "All drills return on exit",
    )
  }
  assert.equal(pixel(xray.frames.fivePercent, 100, 150)[3], 13)
  assert.equal(pixel(xray.frames.fivePercent, 40, 50)[3], 255)
  assert.equal(pixel(xray.frames.dimmed, 100, 150)[3], 102)
  assert.equal(
    xray.frames.hover,
    xray.frames.dimmed,
    "X-Ray must ignore highlighting on both selected and unrelated copper",
  )
  assert.deepEqual(
    pixel(xray.frames.exit, 100, 150),
    [255, 78, 78, 255],
    "Highlighting resumes after exiting X-Ray",
  )
  assert.deepEqual(pixel(xray.frames.changed, 40, 50), layerColors.bottom)
  assert.equal(pixel(xray.frames.changed, 160, 50)[3], 102)
  assert.equal(pixel(xray.frames.exit, 40, 50)[3], 0)
  assert.equal(pixel(xray.frames.exit, 160, 50)[3], 255)
  assert.deepEqual(pixel(xray.frames.filtered, 100, 100), layerColors.bottom)
  assert.deepEqual(pixel(xray.frames.resized, 100, 100), layerColors.top)
  assert.equal(
    xray.geometryUploads,
    1,
    "X-Ray changes and resizing must reuse geometry",
  )
  assert.deepEqual(pixel(visibility.transparent, 70, 70), [0, 0, 0, 0])
  for (const png of [
    visibility.black,
    visibility.maskOff,
    visibility.independentDraw,
  ]) {
    assert.deepEqual(
      pixel(png, 70, 70),
      [0, 0, 0, 255],
      "Empty board area must stay black with material/mask off",
    )
    assert.deepEqual(
      pixel(png, 100, 100),
      [200, 52, 52, 255],
      "Copper must remain visible",
    )
    assert(pixel(png, 40, 70)[0] > 40, "Board outline must remain visible")
  }
  assert.deepEqual(pixel(visibility.maskOn, 70, 70), [12, 55, 33, 255])
  assert.deepEqual(pixel(visibility.retainedMask, 70, 70), [12, 55, 33, 255])
  assert.deepEqual(pixel(visibility.substrate, 70, 70), [70, 72, 72, 255])
  assert.equal(
    visibility.geometryUploads,
    1,
    "Visibility changes must not rebuild geometry",
  )
  const names = await page.evaluate(() => window.gpuTest.names)
  await mkdir(new URL("./actual/", import.meta.url), { recursive: true })
  async function snapshot(name: string) {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    const buffer = await page.locator("canvas").screenshot()
    // SwiftShader uses different MSAA sample positions on the subpixel courtyard edge.
    const baseline =
      process.env.WEBGPU_SOFTWARE && name === "annotations"
        ? `${name}.swiftshader`
        : name
    const file = new URL(`./snapshots/${baseline}.png`, import.meta.url)
    if (process.env.UPDATE_SNAPSHOTS) await writeFile(file, buffer)
    else {
      const expected = PNG.sync.read(await readFile(file)),
        actual = PNG.sync.read(buffer)
      assert.equal(actual.width, expected.width)
      assert.equal(actual.height, expected.height)
      const diff = new PNG({ width: actual.width, height: actual.height })
      const changed = pixelmatch(
        expected.data,
        actual.data,
        diff.data,
        actual.width,
        actual.height,
        { threshold: 0.1 },
      )
      if (changed > actual.width * actual.height * 0.002) {
        await writeFile(
          new URL(`./actual/${name}.png`, import.meta.url),
          buffer,
        )
        await writeFile(
          new URL(`./actual/${name}.diff.png`, import.meta.url),
          PNG.sync.write(diff),
        )
        throw new Error(
          `${name}: ${changed} pixels differ from the approved snapshot`,
        )
      }
    }
    console.log(`snapshot ${name}`)
    return PNG.sync.read(buffer)
  }
  const soldermask = await page.evaluate(async () => {
    const drawer = window.gpuTest.drawer
    drawer.drawElements(
      [
        {
          type: "pcb_board",
          pcb_board_id: "board",
          center: { x: 0, y: 0 },
          width: 10,
          height: 6,
          thickness: 1.6,
          num_layers: 2,
          material: "fr4",
        },
        {
          type: "pcb_copper_pour",
          pcb_copper_pour_id: "pour",
          shape: "rect",
          layer: "top",
          center: { x: 0, y: 0 },
          width: 8,
          height: 4,
          covered_with_solder_mask: true,
        },
        {
          type: "pcb_soldermask_opening",
          pcb_soldermask_opening_id: "opening",
          shape: "rect",
          layer: "top",
          x: 0,
          y: 0,
          width: 4,
          height: 2,
        },
      ],
      {
        transform: { a: 60, b: 0, c: 0, d: -60, e: 400, f: 300 },
        selectedLayer: "top",
        showSolderMask: true,
        showCopperPours: true,
        copperPourOpacity: 1,
        xRayElementIds: [],
        highlightedElementIds: [],
        background: [0, 0, 0, 1],
      },
    )
    await drawer.flush()
    return {
      diagnostics: drawer.diagnostics,
      png: document
        .querySelector("canvas")!
        .toDataURL("image/png")
        .split(",")[1],
    }
  })
  assert.deepEqual(soldermask.diagnostics, [])
  await snapshot("soldermask-opening")
  // Only the opening exposes copper; the surrounding soldermask stays intact.
  assert.deepEqual(pixel(soldermask.png, 400, 300), layerColors.top)
  assert.deepEqual(pixel(soldermask.png, 580, 300), [12, 55, 33, 255])
  const throughPad = await page.evaluate(async () => {
    const drawer = window.gpuTest.drawer
    drawer.drawElements(
      [
        {
          type: "pcb_plated_hole",
          pcb_plated_hole_id: "pad",
          shape: "circle",
          x: 0,
          y: 0,
          outer_diameter: 1.6,
          hole_diameter: 0.8,
          layers: ["top", "bottom"],
        },
        {
          type: "pcb_trace",
          pcb_trace_id: "trace",
          route: [
            { route_type: "wire", x: -4, y: 0, width: 0.4, layer: "top" },
            {
              route_type: "through_pad",
              start: { x: 0, y: 0 },
              end: { x: 0, y: 0 },
              start_layer: "top",
              end_layer: "bottom",
              width: 0.4,
              pcb_plated_hole_id: "pad",
            },
            { route_type: "wire", x: 4, y: 0, width: 0.4, layer: "bottom" },
          ],
        },
      ],
      {
        transform: { a: 60, b: 0, c: 0, d: -60, e: 400, f: 300 },
        layers: ["top", "bottom", "drill"],
        selectedLayer: "top",
        hiddenLayerOpacity: 1,
        showSolderMask: false,
        background: [0, 0, 0, 1],
      },
    )
    await drawer.flush()
    return {
      diagnostics: drawer.diagnostics,
      png: document
        .querySelector("canvas")!
        .toDataURL("image/png")
        .split(",")[1],
    }
  })
  assert.deepEqual(throughPad.diagnostics, [])
  assert.deepEqual(pixel(throughPad.png, 280, 300), layerColors.top)
  assert.deepEqual(pixel(throughPad.png, 520, 300), layerColors.bottom)
  await snapshot("through-pad-trace")
  const { scene: pcbBendScene } = prepareComparison({
    width: 800,
    height: 600,
    elements: pcbBendFixture,
    matrix: { a: 14, b: 0, c: 0, d: -14, e: 400, f: 300 },
    contextTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    options: {},
  })
  assert(pcbBendScene)
  const pcbBend = await page.evaluate((scene) => {
    const drawer = window.gpuTest.drawer
    const options = {
      transform: scene.transform,
      showBendLines: true,
      selectedLayer: "top",
      hiddenLayerOpacity: 0,
      background: [0, 0, 0, 1] as const,
    }
    drawer.drawElements(scene.elements as unknown as CircuitJson, options)
    return {
      diagnostics: drawer.diagnostics,
      png: document
        .querySelector("canvas")!
        .toDataURL("image/png")
        .split(",")[1],
    }
  }, pcbBendScene)
  assert.deepEqual(pcbBend.diagnostics, [])
  // The owning boards remain, but neither bend centerline is rendered.
  assert.deepEqual(pixel(pcbBend.png, 123, 215), [0, 0, 0, 255])
  assert.deepEqual(pixel(pcbBend.png, 623, 408), [0, 0, 0, 255])
  const pcbBendSvg = convertCircuitJsonToPcbSvg(
    pcbBendScene.elements as Parameters<typeof convertCircuitJsonToPcbSvg>[0],
    {
      width: pcbBendScene.width,
      height: pcbBendScene.height,
      viewport: pcbBendScene.viewport,
      layer: "top",
      showBendLines: true,
      showSolderMask: false,
      shouldDrawErrors: false,
      shouldDrawRatsNest: false,
      includeVersion: false,
      drawPaddingOutsideBoard: true,
      backgroundColor: pcbBendScene.background,
      colorOverrides: { boardOutline: "#d0d2cd" },
    },
  )
  assert.equal(pcbBendSvg.match(/class="pcb-bend-line"/g)?.length, 2)
  // Resvg does not load CSS @font-face URLs. Load the reference SVG's embedded
  // alphabet explicitly so the left panel includes its actual bend labels.
  const embeddedFont = pcbBendSvg.match(/data:font\/ttf;base64,([^']+)/)?.[1]
  assert(embeddedFont)
  const comparisonDir = new URL("./actual/parity/", import.meta.url)
  await mkdir(comparisonDir, { recursive: true })
  const fontFile = new URL("pcb-bend-reference.ttf", comparisonDir)
  await writeFile(fontFile, Buffer.from(embeddedFont, "base64"))
  const svgPng = new Resvg(pcbBendSvg, {
    font: { loadSystemFonts: false, fontFiles: [fileURLToPath(fontFile)] },
  })
    .render()
    .asPng()
  const pcbBendReference = PNG.sync.read(svgPng)
  assert.deepEqual(
    pixel(svgPng.toString("base64"), 123, 215),
    [255, 213, 79, 255],
  )
  assert.deepEqual(
    pixel(svgPng.toString("base64"), 623, 408),
    [255, 213, 79, 255],
  )
  assert(
    (
      await featureSnapshot(
        "pcb-bend",
        pcbBendReference,
        PNG.sync.read(Buffer.from(pcbBend.png, "base64")),
        "pcb-bend",
      )
    ).pass,
    "PCB bend SVG/WebGPU comparison snapshot",
  )
  console.log("snapshot pcb-bend (circuit-to-svg / circuit-json-webgpu)")
  for (const name of names) {
    const stats = await page.evaluate(
      (name) => window.gpuTest.renderFixture(name),
      name,
    )
    assert.deepEqual(stats.diagnostics, [])
    const image = await snapshot(name)
    // Independent checks: a board cutout uses the pink drill color; a pour hole
    // reveals the board/bottom copper rather than red top-layer copper.
    const at = (x: number, y: number) => [
      ...image.data.slice(
        ((y + 1) * image.width + x + 1) * 4,
        ((y + 1) * image.width + x + 1) * 4 + 3,
      ),
    ]
    if (name.startsWith("keepouts-")) {
      const stripe = at(260, 258),
        fill = at(264, 258)
      assert(
        stripe.every((c, i) => c > fill[i] + 50),
        "Keepout must have bright stripes over a translucent fill",
      )
      assert(
        fill.every((c) => c > 0),
        "Keepout interior must not disappear into the clearance",
      )
      const copper =
        name === "keepouts-top"
          ? layerColors.top
          : name === "keepouts-inner"
            ? layerColors.inner1
            : layerColors.bottom
      assert(
        at(260, 202).every((c, i) => Math.abs(c - copper[i] * 0.5) <= 0.5),
        "Hatching must stay inside the circular boundary",
      )
      assert.deepEqual(
        at(260, 300),
        [255, 38, 226],
        "The mounting hole must remain visible",
      )
      assert(
        at(540, 300).some((c, i) => c > copper[i] + 20),
        "Keepouts must remain visible above a later copper pour",
      )
    }
    if (name === "silkscreen-graphics") {
      // World coordinates use the gallery's 14 px/mm camera. Check ink and
      // clear holes independently so snapshot updates cannot fill the counters.
      assert.deepEqual(
        at(232, 230),
        [242, 237, 161],
        "Top graphic must use top silkscreen color",
      )
      assert.deepEqual(at(232, 300), [0, 0, 0], "Circular hole must stay clear")
      assert.deepEqual(
        at(568, 300),
        [242, 237, 161],
        "Bottom graphic must use bottom silkscreen color",
      )
      assert.deepEqual(
        at(540, 300),
        [0, 0, 0],
        "First bottom hole must stay clear",
      )
      assert.deepEqual(
        at(596, 300),
        [0, 0, 0],
        "Second bottom hole must stay clear",
      )
      assert.deepEqual(
        at(638, 230),
        [0, 0, 0],
        "Outside the curved boundary stays clear",
      )
    }
    if (name === "board-outline-cutout")
      assert.deepEqual(at(400, 300), [255, 38, 226])
    if (name === "pour-holes-and-arcs") {
      assert(at(200, 300)[0] >= 100)
      assert(at(400, 280)[0] < 100)
    }
  }
  const large = await page.evaluate(() => window.gpuTest.renderLarge())
  assert.deepEqual(large.diagnostics, [])
  await snapshot("am3352-dev-board")
  const navigation = await page.evaluate(
    async (frameCount) => {
      const drawer = window.gpuTest.drawer,
        uploads = drawer.stats.geometryUploads,
        samples = [],
        frames = []
      let previous = performance.now()
      for (let i = 0; i < frameCount; i++) {
        await new Promise(requestAnimationFrame)
        const start = performance.now()
        frames.push(start - previous)
        previous = start
        const scale = 9 * (1 + i / 60)
        drawer.render({
          transform: { a: scale, b: 0, c: 0, d: -scale, e: 400 + i, f: 300 },
        })
        samples.push(performance.now() - start)
      }
      await drawer.flush()
      samples.sort((a, b) => a - b)
      frames.sort((a, b) => a - b)
      return {
        geometryUploadsDuringZoom: drawer.stats.geometryUploads - uploads,
        submitP95Ms: samples[Math.floor(frameCount * 0.95)],
        frameP95Ms: frames[Math.floor(frameCount * 0.95)],
        maxFrameMs: frames.at(-1),
      }
    },
    process.env.WEBGPU_SOFTWARE ? 12 : 90,
  )
  assert.equal(navigation.geometryUploadsDuringZoom, 0)
  const adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter(),
      info = adapter!.info
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter,
    }
  })
  await page.evaluate(async () => {
    const drawer = window.gpuTest.drawer,
      canvas = document.querySelector("canvas")!
    canvas.width = 1200
    canvas.height = 900
    drawer.render()
    await drawer.flush()
    drawer.setCircuitJson([])
    drawer.render()
    await drawer.flush()
    drawer.dispose()
    drawer.dispose()
  })
  // Ignore the browser's optional favicon request.
  assert.deepEqual(
    errors.filter((e) => !e.includes("404")),
    [],
  )
  const report = { snapshots: names.length + 4, adapter, large, navigation }
  await writeFile(
    new URL("./actual/report.json", import.meta.url),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
