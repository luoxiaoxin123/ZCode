// 会话内的拦截计数：连续拦截或累计拦截达到上限后，把决定交还给用户，避免 agent 反复撞墙。
import type { AutoModeDenialLimits } from "@zcode/shared/auto-mode";

export interface DenialState {
  consecutive: number;
  total: number;
}

export class AutoModeDenialTracker {
  private state: DenialState = { consecutive: 0, total: 0 };

  snapshot(): DenialState {
    return { ...this.state };
  }

  recordAllow(): void {
    this.state = { ...this.state, consecutive: 0 };
  }

  recordBlock(): void {
    this.state = { consecutive: this.state.consecutive + 1, total: this.state.total + 1 };
  }

  /**
   * 下一次拦截是否会触发上限。触发后返回提示原因，并重置计数：
   * 用户看过一次之后，重新开始计数。
   */
  consumeLimit(limits: AutoModeDenialLimits): string | null {
    if (this.state.consecutive >= limits.maxConsecutive) {
      const count = this.state.consecutive;
      this.state = { ...this.state, consecutive: 0 };
      return `${count} consecutive actions were blocked by the auto mode reviewer. Please review before continuing.`;
    }
    if (this.state.total >= limits.maxTotal) {
      const count = this.state.total;
      this.state = { consecutive: 0, total: 0 };
      return `${count} actions were blocked by the auto mode reviewer in this session. Please review before continuing.`;
    }
    return null;
  }
}
