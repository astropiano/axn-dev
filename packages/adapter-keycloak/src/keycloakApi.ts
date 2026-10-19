export function expand(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? process.env[name] ?? "");
}

export function kcUrl(env: Record<string, string>): string {
  const raw = env.KC_URL ?? "";
  if (!raw) throw new Error("KC_URL is not set");
  return expand(raw, env).replace(/\/$/, "");
}

export function realm(env: Record<string, string>): string {
  return env.KEYCLOAK_REALM ?? "master";
}

export async function adminToken(env: Record<string, string>): Promise<string> {
  const kc = kcUrl(env);
  const username = env.KEYCLOAK_ADMIN_USER ?? "admin";
  const password = env.KEYCLOAK_ADMIN_PASSWORD ?? "admin";
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username,
    password,
  });

  const response = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Keycloak token request failed: ${response.status} ${text}`);
  }
  const json = (await response.json()) as any;
  if (!json.access_token) throw new Error("Keycloak token response did not include access_token");
  return json.access_token as string;
}

export async function findUserId(username: string, env: Record<string, string>): Promise<string> {
  const kc = kcUrl(env);
  const r = realm(env);
  const token = await adminToken(env);

  const response = await fetch(`${kc}/admin/realms/${r}/users?username=${encodeURIComponent(username)}&exact=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Keycloak findUser failed: ${response.status} ${text}`);
  }

  const list = (await response.json()) as any[];
  const user = list.find((u) => u.username === username);
  if (!user?.id) throw new Error(`User '${username}' not found in Keycloak`);
  return user.id as string;
}
