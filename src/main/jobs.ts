import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { channels } from "../shared/channels";
import type { JobEvent } from "../shared/models";

export class JobManager {
  private readonly controllers = new Map<string, AbortController>();
  private window: BrowserWindow | null = null;

  attach(window: BrowserWindow): void { this.window = window; }

  create(kind: JobEvent["kind"], message: string, total: number | null = null): { id: string; signal: AbortSignal; emit: (patch: Partial<JobEvent>) => void } {
    const id = randomUUID();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let state: JobEvent = { id, kind, status: "queued", completed: 0, total, message };
    const emit = (patch: Partial<JobEvent>): void => {
      state = { ...state, ...patch, id, kind };
      this.window?.webContents.send(channels.jobsEvent, state);
      if (["completed", "failed", "cancelled"].includes(state.status)) this.controllers.delete(id);
    };
    queueMicrotask(() => emit({ status: "running" }));
    return { id, signal: controller.signal, emit };
  }

  cancel(id: string): void { this.controllers.get(id)?.abort(); }
}
