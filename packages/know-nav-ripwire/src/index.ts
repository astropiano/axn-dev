import type { CodeLocation, CodeNavigator, NavigationQuery, NavigationResult } from "@axn-dev/core";
import { navigate, repoRootOf, runRipwire } from "./ripwire.js";

/**
 * Code navigator "ripwire" — answers callers, callees, implementations and
 * references by running the `ripwire` binary over the repository that holds
 * the file. ripwire parses on every call, so there is no index to go stale.
 */
export const navigator: CodeNavigator = {
  async navigate(query: NavigationQuery, location: CodeLocation, target?: CodeLocation): Promise<NavigationResult> {
    return navigate(query, location, await repoRootOf(location.path), runRipwire, target);
  },
};

export default navigator;
