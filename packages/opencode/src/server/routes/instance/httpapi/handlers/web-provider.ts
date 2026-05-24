import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { WebProviderRoutes } from "@/provider/web/routes"

export const webProviderRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const hono = yield* Effect.sync(() => WebProviderRoutes())
    yield* router.add("*", "/provider/*", (request) =>
      Effect.promise(async () => {
        const webRequest = await HttpServerRequest.toWebRequest(request)
        const response = await hono.fetch(webRequest)
        return HttpServerResponse.fromWebResponse(response)
      }),
    )
  }),
)
