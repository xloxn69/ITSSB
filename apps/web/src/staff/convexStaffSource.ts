import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { LiveClient } from "../live/convexSource";
import { mapError } from "../live/convexSource";
import type { StaffSource } from "./source";

/** Staff functions over the signed-in Convex client, referenced by name. */
export function convexStaffSource(client: LiveClient & Pick<ConvexReactClient, "action">): StaffSource {
  return {
    watch(name, args, onValue, onError) {
      const query = makeFunctionReference<"query", Record<string, string>, unknown>(name);
      const watcher = client.watchQuery(query as Parameters<LiveClient["watchQuery"]>[0], args);
      let active = true;
      const emit = () => {
        if (!active) return;
        try {
          const value = watcher.localQueryResult();
          if (value !== undefined) onValue(value);
        } catch (error) {
          onError(mapError(error));
        }
      };
      const stop = watcher.onUpdate(emit);
      emit();
      return () => {
        active = false;
        stop();
      };
    },
    mutate(name, args) {
      return client.mutation(makeFunctionReference<"mutation", Record<string, string | number>, unknown>(name), args);
    },
    act(name, args) {
      return client.action(makeFunctionReference<"action", Record<string, string | number>, unknown>(name), args);
    },
  };
}
