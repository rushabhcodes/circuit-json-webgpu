import { CircuitToWebGpuDrawer, type CircuitJson } from "../lib"

export async function checkCopperPourOpacity() {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 200
  const drawer = await CircuitToWebGpuDrawer.create(canvas)
  const elements = [
    ...["top", "bottom", "inner1"].map((layer, i) => ({
      type: "pcb_copper_pour",
      pcb_copper_pour_id: `pour_${layer}`,
      shape: "rect",
      layer,
      center: { x: -6 + i * 6, y: 0 },
      width: 4,
      height: 4,
    })),
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pad",
      shape: "rect",
      layer: "top",
      x: -6,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "trace",
      route: [
        { route_type: "wire", layer: "top", x: -8, y: 5, width: 1 },
        { route_type: "wire", layer: "top", x: 8, y: 5, width: 1 },
      ],
    },
  ] as CircuitJson
  const frames: Record<string, string> = {}
  const capture = (name: string) => {
    frames[name] = canvas.toDataURL("image/png").split(",")[1]
  }
  try {
    drawer.drawElements(elements, {
      transform: { a: 10, b: 0, c: 0, d: -10, e: 100, f: 100 },
      hiddenLayerOpacity: 0.4,
    })
    capture("default")
    for (const background of ["black", "white"] as const) {
      const value = background === "black" ? 0 : 1
      drawer.render({
        hiddenLayerOpacity: 1,
        background: [value, value, value, 1],
      })
      capture(background)
    }
    drawer.render({ hiddenLayerOpacity: 0.4, background: [0, 0, 0, 0] })
    for (const [name, opacity] of Object.entries({
      half: 0.5,
      zero: 0,
      negative: -1,
      aboveOne: 2,
      nan: Number.NaN,
    })) {
      drawer.render({ copperPourOpacity: opacity })
      capture(name)
    }
    drawer.render({ copperPourOpacity: 0.5 })
    drawer.render({ transform: drawer.realToCanvasMat })
    capture("retained")
    drawer.render({ showCopperPours: false, copperPourOpacity: 1 })
    capture("hidden")
    drawer.render({ showCopperPours: true, copperPourOpacity: 0.5 })
    capture("shown")
    drawer.render({ xRayElementIds: ["pour_top"] })
    capture("xray")
    drawer.render({ copperPourOpacity: 0 })
    capture("xrayHidden")
    drawer.drawElements(elements, {
      transform: drawer.realToCanvasMat,
      hiddenLayerOpacity: 0.4,
    })
    capture("independent")
    return { frames, elements, geometryUploads: drawer.stats.geometryUploads }
  } finally {
    drawer.dispose()
  }
}
