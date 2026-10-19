import type { FlowAdapter, FlowAdapterContext, FlowAdapterStep } from "@axn-dev/core";
import { KeycloakAdapter } from "./keycloakAdapter.js";

/**
 * Flow adapter "keycloak" — manages Keycloak users from flow steps.
 *
 *   <step adapter="keycloak" action="createUser" username="..." email="..." password="..."/>
 *   <keycloak action="deleteUser" username="..."/>
 *   <keycloak action="resetPassword" username="..." password="..."/>
 *
 * Env: KC_URL (required), KEYCLOAK_REALM (default master),
 * KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD (default admin/admin).
 */
export const adapter: FlowAdapter = {
  async run(step: FlowAdapterStep, ctx: FlowAdapterContext): Promise<string> {
    return KeycloakAdapter.run(step, ctx.env);
  },
};

export default adapter;
