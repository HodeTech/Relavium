import type { ToolFileDiff } from '@relavium/core';
import type { ReviewDocument } from './tool-review-projection.js';
export interface ToolDisplay {
  readonly callId: string;
  readonly toolId: string;
  readonly outcome: 'running' | 'success' | 'failure' | 'denied' | 'unknown';
  readonly target?: string;
  readonly stats?: ToolFileDiff['stats'];
  readonly document?: ReviewDocument;
  readonly summary?: string;
}
