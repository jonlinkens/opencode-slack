import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const executeFile = promisify(execFile);

export async function readKeychainPassword(service: string) {
  const { stdout } = await executeFile("security", ["find-generic-password", "-s", service, "-w"]);
  return stdout.trim();
}

const slackResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional() });
export const slackSuccessSchema = z.object({ ok: z.literal(true) });

export async function callSlackApi<T>(
  method: string,
  token: string,
  params: Record<string, z.output<z.ZodJSONSchema> | undefined>,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
) {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    const text = z.string().safeParse(value);
    body.set(key, text.success ? text.data : JSON.stringify(value));
  });
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    signal,
  });
  const data = await response.json();
  const { ok, error } = slackResponseSchema.parse(data);
  if (!ok) {
    throw new Error(`Slack ${method} failed: ${error}`);
  }
  return schema.parse(data);
}

export type Directory = {
  channels: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
};

export const EMPTY_SLACK_DIRECTORY: Directory = { channels: new Map(), users: new Map() };

const channelSchema = z.object({ id: z.string(), name: z.string() });
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  deleted: z.boolean().optional(),
  profile: z.object({ display_name: z.string().optional(), real_name: z.string().optional() }).optional(),
});
const directoryPageSchema = z.object({
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const channelsPageSchema = directoryPageSchema.extend({ channels: z.array(channelSchema) });
const usersPageSchema = directoryPageSchema.extend({ members: z.array(userSchema) });

async function fetchChannels(token: string) {
  const channels: z.infer<typeof channelSchema>[] = [];
  let cursor = "";
  do {
    const page = await callSlackApi(
      "conversations.list",
      token,
      {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
        cursor,
      },
      channelsPageSchema,
    );
    channels.push(...page.channels);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return channels;
}

async function fetchUsers(token: string) {
  const users: z.infer<typeof userSchema>[] = [];
  let cursor = "";
  do {
    const page = await callSlackApi("users.list", token, { limit: 1000, cursor }, usersPageSchema);
    users.push(...page.members);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return users;
}

const DIRECTORY_TTL = 60 * 60 * 1000;
let cachedDirectory: { fetchedAt: number; directory: Directory } | undefined;

export async function fetchSlackDirectory(token: string, now = Date.now()) {
  if (cachedDirectory && now - cachedDirectory.fetchedAt < DIRECTORY_TTL) {
    return cachedDirectory.directory;
  }
  const [channels, users] = await Promise.all([fetchChannels(token), fetchUsers(token)]);
  const userIDsByName = new Map<string, string>();
  users
    .filter((user) => !user.deleted)
    .forEach((user) => {
      [user.name, user.profile?.display_name, user.profile?.real_name]
        .filter((name): name is string => Boolean(name))
        .forEach((name) => userIDsByName.set(name.toLowerCase().replaceAll(" ", ""), user.id));
    });
  const directory: Directory = {
    channels: new Map(channels.map((channel) => [channel.name, channel.id])),
    users: userIDsByName,
  };
  cachedDirectory = { fetchedAt: now, directory };
  return directory;
}
