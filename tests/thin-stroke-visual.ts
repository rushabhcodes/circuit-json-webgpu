import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { chromium } from "playwright"
import { PNG } from "pngjs"

const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    watch: { ignored: ["**/*"] },
  },
  logLevel: "error",
})
await server.listen()
const browser = await chromium.launch({
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
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`${server.resolvedUrls!.local[0]}tests/parity/`)
  const results = await page.evaluate(async () => {
    const path = "/lib/index.ts"
    const { CircuitToWebGpuDrawer } = await import(path)
    const frames = []
    for (const sampleCount of [1, 4])
      for (const layer of ["top", "bottom"])
        for (const opacity of [0.5, 1]) {
          const canvas = document.createElement("canvas")
          canvas.width = canvas.height = 200
          const drawer = await CircuitToWebGpuDrawer.create(canvas, {
            sampleCount,
            layerColors: { [`${layer}_silkscreen`]: [1, 1, 1, opacity] },
          })
          const capture = () => canvas.toDataURL("image/png").split(",")[1]
          try {
            for (const shape of ["circle", "rounded"] as const) {
              const element =
                shape === "circle"
                  ? {
                      type: "pcb_silkscreen_circle",
                      pcb_silkscreen_circle_id: "curve",
                      layer,
                      center: { x: 0, y: 0 },
                      radius: 20,
                      stroke_width: 0.1,
                    }
                  : {
                      type: "pcb_silkscreen_rect",
                      pcb_silkscreen_rect_id: "curve",
                      layer,
                      center: { x: 0, y: 0 },
                      width: 80,
                      height: 40,
                      corner_radius: 12,
                      ccw_rotation: 17,
                      stroke_width: 0.1,
                    }
              drawer.setCircuitJson([element])
              const uploads = drawer.stats.geometryUploads
              for (const scale of shape === "circle"
                ? [0.25, 0.5, 1, 2, 4]
                : [0.25, 0.5, 1, 2])
                for (const phase of [0, 0.25, 0.5]) {
                  const transform = {
                    a: scale,
                    b: 0,
                    c: 0,
                    d: -scale,
                    e: 100 + phase,
                    f: 100 + phase,
                  }
                  drawer.render({
                    transform,
                    selectedLayer: layer,
                    background: [0, 0, 0, 0],
                  })
                  frames.push({
                    shape,
                    sampleCount,
                    layer,
                    opacity,
                    transform,
                    png: capture(),
                  })
                }
              if (shape === "circle") {
                const angle = (17 * Math.PI) / 180
                for (const transform of [
                  {
                    a: 0.5 * Math.cos(angle),
                    b: 0.5 * Math.sin(angle),
                    c: 0.5 * Math.sin(angle),
                    d: -0.5 * Math.cos(angle),
                    e: 100.25,
                    f: 100.5,
                  },
                  { a: 1.2, b: 0.3, c: 0.2, d: -0.8, e: 100.25, f: 100.5 },
                ]) {
                  drawer.render({ transform })
                  frames.push({
                    shape,
                    sampleCount,
                    layer,
                    opacity,
                    transform,
                    png: capture(),
                  })
                }
              }
              if (drawer.stats.geometryUploads !== uploads)
                throw Error("Zoom reuploaded stroke geometry")
              drawer.render({ showSilkscreen: false })
              frames.push({
                shape: "hidden" as const,
                sampleCount,
                layer,
                opacity,
                transform: drawer.realToCanvasMat,
                png: capture(),
              })
              drawer.render({
                showSilkscreen: true,
                layers: [`${layer === "top" ? "bottom" : "top"}_silkscreen`],
              })
              frames.push({
                shape: "hidden" as const,
                sampleCount,
                layer,
                opacity,
                transform: drawer.realToCanvasMat,
                png: capture(),
              })
              drawer.render({ layers: undefined })
              if (drawer.stats.geometryUploads !== uploads)
                throw Error("Visibility reuploaded stroke geometry")
            }
            if (drawer.diagnostics.length)
              throw Error(JSON.stringify(drawer.diagnostics))
          } finally {
            drawer.dispose()
          }
        }
    return frames
  })
  const metrics = []
  for (const result of results) {
    const image = PNG.sync.read(Buffer.from(result.png, "base64"))
    let energy = 0,
      peak = 0
    for (let i = 3; i < image.data.length; i += 4) {
      energy += image.data[i] / 255
      peak = Math.max(peak, image.data[i])
    }
    if (result.shape === "hidden") {
      assert.equal(energy, 0, "Visibility and layer filtering")
      continue
    }
    const t = result.transform
    const project = (x: number, y: number) => ({
      x: t.a * x + t.c * y + t.e,
      y: t.b * x + t.d * y + t.f,
    })
    const points: { x: number; y: number }[] = []
    if (result.shape === "circle") {
      for (let i = 0; i < 360; i++)
        points.push(
          project(
            20 * Math.cos((i * Math.PI) / 180),
            20 * Math.sin((i * Math.PI) / 180),
          ),
        )
    } else {
      const rotation = (17 * Math.PI) / 180
      const add = (x: number, y: number) =>
        points.push(
          project(
            x * Math.cos(rotation) - y * Math.sin(rotation),
            x * Math.sin(rotation) + y * Math.cos(rotation),
          ),
        )
      for (let corner = 0; corner < 4; corner++) {
        const cx = corner === 0 || corner === 3 ? 28 : -28,
          cy = corner < 2 ? 8 : -8
        for (let i = 0; i <= 60; i++) {
          const angle = ((corner + i / 60) * Math.PI) / 2
          add(cx + 12 * Math.cos(angle), cy + 12 * Math.sin(angle))
        }
      }
      for (let i = 0; i <= 80; i++) {
        const x = -28 + (56 * i) / 80
        add(x, 20)
        add(x, -20)
      }
      for (let i = 0; i <= 30; i++) {
        const y = -8 + (16 * i) / 30
        add(40, y)
        add(-40, y)
      }
    }
    for (const point of points) {
      let alpha = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = Math.floor(point.x) + dx,
            y = Math.floor(point.y) + dy
          if (x >= 0 && x < image.width && y >= 0 && y < image.height)
            alpha = Math.max(alpha, image.data[(y * image.width + x) * 4 + 3])
        }
      assert(
        alpha > 0,
        `Missing ${result.shape} outline: ${JSON.stringify({ ...result, png: undefined, point })}`,
      )
    }
    const determinant = Math.abs(t.a * t.d - t.b * t.c)
    const perimeter =
      result.shape === "circle"
        ? 40 * Math.PI
        : 2 * (80 + 40 - 4 * 12) + 24 * Math.PI
    const expected = perimeter * 0.1 * determinant * result.opacity
    assert(
      Math.abs(energy - expected) <= Math.max(0.15, expected * 0.08),
      `Stroke area/opacity changed: ${result.shape} ${energy} vs ${expected}`,
    )
    const squaredScale = t.a * t.a + t.b * t.b + t.c * t.c + t.d * t.d
    const maxScale = Math.sqrt(
      (squaredScale +
        Math.sqrt(
          Math.max(
            0,
            squaredScale * squaredScale - 4 * determinant * determinant,
          ),
        )) /
        2,
    )
    assert(
      peak <= Math.ceil(Math.SQRT2 * 0.1 * maxScale * result.opacity * 255) + 2,
      "Subpixel strokes must not become opaque minimum-width lines",
    )
    assert.equal(
      image.data[(100 * image.width + 100) * 4 + 3],
      0,
      "Outline stays hollow",
    )
    metrics.push({
      shape: result.shape,
      sampleCount: result.sampleCount,
      layer: result.layer,
      opacity: result.opacity,
      scale: t.a,
      phase: t.e - 100,
      energy,
      expected,
    })
  }
  assert.deepEqual(errors, [])
  const output = new URL("./actual/thin-strokes/", import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(
    new URL("report.json", output),
    JSON.stringify(metrics, null, 2),
  )
  console.log(
    `${metrics.length} thin-stroke frames pass: continuous outlines, physical width/opacity, both sample counts and sides; zoom and visibility reuse geometry`,
  )
} finally {
  await browser.close()
  await server.close()
}
