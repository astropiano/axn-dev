import type { FlowAdapterStep } from "@axn-dev/core";
import { expand, kcUrl, realm, adminToken, findUserId } from "./keycloakApi.js";

export class KeycloakAdapter {
  static async run(step: FlowAdapterStep, env: Record<string, string>): Promise<string> {
    const args = step.args ?? {};
    const action = args.action ?? "createUser";

    if (action === "createUser") {
      return this.createUser(args, env);
    }
    if (action === "deleteUser") {
      return this.deleteUser(args, env);
    }
    if (action === "resetPassword") {
      return this.resetPassword(args, env);
    }

    throw new Error(`Unknown keycloak action: ${action}`);
  }

  private static async createUser(args: Record<string, string>, env: Record<string, string>): Promise<string> {
    const kc = kcUrl(env);
    const r = realm(env);
    const username = args.username;
    const email = args.email;
    const firstName = args.firstName ?? "";
    const lastName = args.lastName ?? "";
    const password = args.password;

    if (!username) throw new Error("keycloak createUser requires 'username'");
    if (!email) throw new Error("keycloak createUser requires 'email'");
    if (!password) throw new Error("keycloak createUser requires 'password'");

    const token = await adminToken(env);

    const createResponse = await fetch(`${kc}/admin/realms/${r}/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username,
        email,
        firstName,
        lastName,
        enabled: true,
        emailVerified: true,
      }),
    });

    let userId: string;
    if (createResponse.status === 409) {
      // User already exists — reuse it and refresh the password so flows are rerunnable.
      userId = await findUserId(username, env);
    } else {
      if (!createResponse.ok && createResponse.status !== 201) {
        const text = await createResponse.text();
        throw new Error(`Keycloak createUser failed: ${createResponse.status} ${text}`);
      }
      userId = await this.extractUserId(createResponse, kc, r, username, token);
    }

    await fetch(`${kc}/admin/realms/${r}/users/${userId}/reset-password`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "password",
        value: password,
        temporary: false,
      }),
    });

    return `Created user ${username}`;
  }

  private static async extractUserId(
    response: Response,
    kc: string,
    r: string,
    username: string,
    token: string
  ): Promise<string> {
    const location = response.headers.get("Location");
    if (location) {
      const match = location.match(/\/users\/([^/]+)$/);
      if (match) return match[1];
    }

    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text) as any;
        if (json.id) return json.id as string;
      } catch {
        /* fall through */
      }
    }

    const search = await fetch(`${kc}/admin/realms/${r}/users?username=${encodeURIComponent(username)}&exact=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (search.ok) {
      const list = (await search.json()) as any[];
      if (list.length > 0 && list[0].id) return list[0].id as string;
    }

    throw new Error("Could not determine the created user id");
  }

  private static async deleteUser(args: Record<string, string>, env: Record<string, string>): Promise<string> {
    const username = args.username;
    if (!username) throw new Error("keycloak deleteUser requires 'username'");

    const userId = await findUserId(username, env);
    const kc = kcUrl(env);
    const r = realm(env);
    const token = await adminToken(env);

    const response = await fetch(`${kc}/admin/realms/${r}/users/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Keycloak deleteUser failed: ${response.status} ${text}`);
    }

    return `Deleted user ${username}`;
  }

  private static async resetPassword(args: Record<string, string>, env: Record<string, string>): Promise<string> {
    const username = args.username;
    const password = args.password;
    if (!username) throw new Error("keycloak resetPassword requires 'username'");
    if (!password) throw new Error("keycloak resetPassword requires 'password'");

    const userId = await findUserId(username, env);
    const kc = kcUrl(env);
    const r = realm(env);
    const token = await adminToken(env);

    const response = await fetch(`${kc}/admin/realms/${r}/users/${userId}/reset-password`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "password",
        value: password,
        temporary: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Keycloak resetPassword failed: ${response.status} ${text}`);
    }

    return `Reset password for ${username}`;
  }
}
