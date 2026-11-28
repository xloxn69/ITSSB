/**
 * Family enrollment, link and check-in calls (docs/08 §9.1–§9.2). The
 * server derives who is asking from the sign-in; these pages only show what
 * it answers, and treat a missing answer as "not confirmed", never as done.
 */
import { makeFunctionReference } from "convex/server";
import type { LiveClient } from "../live/convexSource";
import { mapError } from "../live/convexSource";
import type { Unsubscribe } from "../tracking/store";

export type FamilyQueryName =
  | "enrollment:previewInvitation"
  | "enrollment:myRequests"
  | "guardianLinks:myRequests"
  | "tracking:myAssignments"
  | "checkIns:forAssignment";

export type FamilyMutationName = "enrollment:request" | "guardianLinks:request" | "checkIns:record" | "staffInvitations:redeem";

export type FamilyArgs = Record<string, string | null>;

export interface FamilySource {
  watch(name: FamilyQueryName, args: FamilyArgs, onValue: (raw: unknown) => void, onError: (error: unknown) => void): Unsubscribe;
  mutate(name: FamilyMutationName, args: FamilyArgs): Promise<unknown>;
}

export function convexFamilySource(client: LiveClient): FamilySource {
  return {
    watch(name, args, onValue, onError) {
      const query = makeFunctionReference<"query", FamilyArgs, unknown>(name);
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
      return client.mutation(makeFunctionReference<"mutation", FamilyArgs, unknown>(name), args);
    },
  };
}
