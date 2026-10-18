import { expect, test } from "bun:test"
import { CircuitToWebGpuDrawer } from "../lib"

function renderer() {
  const calls: string[] = []
  let finish!: () => void
  let lose!: (error: Error) => void
  const pending = new Promise<void>((resolve, reject) => {
    finish = resolve
    lose = reject
  })
  const resource = (name: string) => ({ destroy: () => calls.push(name) })
  const drawer: CircuitToWebGpuDrawer = Object.assign(
    Object.create(CircuitToWebGpuDrawer.prototype) as CircuitToWebGpuDrawer,
    {
      disposed: false,
      layers: [],
      xRayLayers: [],
      uniform: resource("uniform"),
      xRayUniform: resource("xRayUniform"),
      highlights: resource("highlights"),
      context: { unconfigure: () => calls.push("unconfigure") },
      device: {
        destroy: () => calls.push("device"),
        queue: {
          onSubmittedWorkDone: () => {
            calls.push("wait")
            return pending
          },
        },
      },
    },
  )
  return { drawer, calls, finish, lose }
}

test("dispose waits for queued GPU work before destroying its device", async () => {
  const { drawer, calls, finish } = renderer()
  drawer.dispose()
  expect(calls).toEqual([
    "uniform",
    "xRayUniform",
    "highlights",
    "unconfigure",
    "wait",
  ])
  expect(() => drawer.render()).toThrow("Renderer disposed")
  drawer.dispose()
  expect(calls.filter((call) => call === "wait")).toHaveLength(1)
  finish()
  await Promise.resolve()
  expect(calls.at(-1)).toBe("device")
  expect(calls.filter((call) => call === "device")).toHaveLength(1)
})

test("dispose also destroys a device whose submitted work rejects", async () => {
  const { drawer, calls, lose } = renderer()
  drawer.dispose()
  lose(new Error("device lost"))
  await Promise.resolve()
  expect(calls.at(-1)).toBe("device")
})
