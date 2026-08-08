import { Auth } from "@/auth"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@/effect/run-service"

const runtime = makeRuntime(Auth.Service, LayerNode.compile(Auth.node))

export const authGet = (providerID: string) => runtime.runPromise((svc) => svc.get(providerID))
export const authSet = (providerID: string, info: Auth.Info) => runtime.runPromise((svc) => svc.set(providerID, info))