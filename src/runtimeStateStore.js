import fs from "node:fs/promises";

function defaultState() {
  return {
    version: 1,
    mcp: {
      disabledServers: []
    },
    runner: {
      chats: {}
    },
    skills: {
      chats: {}
    }
  };
}

export class RuntimeStateStore {
  constructor({ config }) {
    this.file = config.app.stateFile;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        mcp: {
          ...defaultState().mcp,
          ...(parsed?.mcp || {})
        },
        runner: {
          ...defaultState().runner,
          ...(parsed?.runner || {})
        },
        skills: {
          ...defaultState().skills,
          ...(parsed?.skills || {})
        }
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return defaultState();
      }

      console.warn(`[state] failed to load runtime state: ${error.message}`);
      return defaultState();
    }
  }

  async save(snapshot) {
    const payload = JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        ...snapshot
      },
      null,
      2
    );

    this.writeQueue = this.writeQueue
      .then(async () => {
        const tempFile = `${this.file}.tmp`;
        await fs.writeFile(tempFile, payload, "utf8");
        await fs.rename(tempFile, this.file);
      })
      .catch((error) => {
        console.warn(`[state] failed to save runtime state: ${error.message}`);
      });

    return this.writeQueue;
  }
}
