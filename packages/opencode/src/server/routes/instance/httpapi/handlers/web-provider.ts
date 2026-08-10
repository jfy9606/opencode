import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { WebProviderRoutes } from "@/provider/web/routes"

export const webProviderRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const webProvider = yield* Effect.sync(() => WebProviderRoutes())
    yield* router.add("POST", "/provider/*", (request) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpServerRequest.toWeb(request)
        const response = yield* Effect.promise(async () => await webProvider.fetch(webRequest))
        return HttpServerResponse.fromWeb(response)
      }),
    )
  }),
)
