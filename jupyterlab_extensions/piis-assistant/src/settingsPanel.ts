/**
 * FlowQuest settings panel.
 *
 * Modal-style overlay opened from the sidebar header or the in-notebook
 * banner. Two tabs:
 *
 *   1. Global — model picker, base URL, API key, and the global XP/level
 *      reset. The endpoint settings are persisted server-side under
 *      ~/.flowquest/settings.json by the SettingsSaveHandler.
 *   2. Notebook — difficulty selector and a "clear this notebook's checkpoints"
 *      button. These mutations go through the per-notebook state pipeline.
 */

import { apiRequest, escapeHtml } from './api';
import type { DifficultyLevel, GlobalSettings, QuestState } from './types';
import { inlineSpinnerHtml, toFriendlyError } from './uiFeedback';

const HOST_CLASS = 'flowquest-settingsHost';

export interface SettingsPanelCallbacks {
  getState: () => QuestState;
  applyState: (state: QuestState) => void;
  setDifficulty: (level: DifficultyLevel) => void;
  flashToast: (message: string) => void;
}

const DIFFICULTY_OPTIONS: Array<{
  value: DifficultyLevel;
  label: string;
  blurb: string;
  icon: string;
}> = [
  {
    value: 'easy',
    label: 'Easy',
    blurb: 'Beginner-friendly explanations, gentle quizzes, generous baseline.',
    icon: '🌱'
  },
  {
    value: 'medium',
    label: 'Medium',
    blurb: 'Practitioner-level depth and balanced grading.',
    icon: '🧗'
  },
  {
    value: 'hard',
    label: 'Hard',
    blurb: 'Senior-reviewer mode. Strict baseline, sharp quizzes.',
    icon: '🔥'
  }
];

export class SettingsPanel {
  private host: HTMLElement | null = null;
  private isOpen = false;
  private tab: 'global' | 'notebook' = 'global';
  private settings: GlobalSettings | null = null;
  private formModel = '';
  private formBaseUrl = '';
  private formApiKey = '';
  private loading = false;
  private saving = false;
  private wipeConfirm = false;
  private wipeScope: 'notebook' | 'global' = 'notebook';

  constructor(private callbacks: SettingsPanelCallbacks) {}

  isVisible(): boolean {
    return this.isOpen;
  }

  open(tab: 'global' | 'notebook' = 'global'): void {
    this.tab = tab;
    if (this.isOpen) {
      this.render();
      return;
    }
    this.isOpen = true;
    this.host = document.createElement('div');
    this.host.className = HOST_CLASS;
    document.body.appendChild(this.host);
    this.render();
    void this.loadSettings();
  }

  close(): void {
    this.isOpen = false;
    this.wipeConfirm = false;
    this.host?.remove();
    this.host = null;
  }

  private async loadSettings(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const response = await apiRequest<GlobalSettings>('piis-assistant/settings', {
        method: 'GET'
      });
      this.settings = response;
      this.formModel = response.model;
      this.formBaseUrl = response.baseUrl;
      this.formApiKey = '';
    } catch (error) {
      this.callbacks.flashToast(`Could not load settings: ${(error as Error).message}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async save(): Promise<void> {
    if (!this.host) return;
    this.saving = true;
    this.render();
    try {
      const payload: Record<string, unknown> = {
        model: this.formModel,
        baseUrl: this.formBaseUrl
      };
      if (this.formApiKey.trim()) {
        payload.apiKey = this.formApiKey.trim();
      }
      const response = await apiRequest<GlobalSettings>('piis-assistant/settings/save', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      this.settings = response;
      this.formModel = response.model;
      this.formBaseUrl = response.baseUrl;
      this.formApiKey = '';
      this.callbacks.flashToast('Settings saved.');
    } catch (error) {
      const friendly = toFriendlyError(error);
      this.callbacks.flashToast(`Save failed: ${friendly.message}`);
    } finally {
      this.saving = false;
      this.render();
    }
  }

  private setDifficulty(level: DifficultyLevel): void {
    this.callbacks.setDifficulty(level);
    this.callbacks.flashToast(`Difficulty set to ${level}.`);
    this.render();
  }

  private async wipe(): Promise<void> {
    try {
      const state = this.callbacks.getState();
      const response = await apiRequest<{ state: QuestState }>('piis-assistant/state/wipe', {
        method: 'POST',
        body: JSON.stringify({
          scope: this.wipeScope,
          notebookPath: state?.notebookPath ?? ''
        })
      });
      this.callbacks.applyState(response.state);
      this.callbacks.flashToast(
        this.wipeScope === 'global'
          ? 'All FlowQuest progress reset.'
          : "This notebook's checkpoints reset."
      );
      this.wipeConfirm = false;
    } catch (error) {
      this.callbacks.flashToast(`Wipe failed: ${(error as Error).message}`);
    }
    this.render();
  }

  private render(): void {
    if (!this.host) return;

    this.host.innerHTML = `
      <div class="flowquest-settingsBackdrop" data-action="close"></div>
      <div class="flowquest-settingsModal flowquest" role="dialog" aria-modal="true">
        <header class="flowquest-settingsHeader">
          <div class="flowquest-settingsHeading">
            <span class="flowquest-settingsIcon">⚙️</span>
            <div>
              <div class="flowquest-cardTitle">FlowQuest Settings</div>
              <div class="flowquest-dim">Global model + per-notebook quest options.</div>
            </div>
          </div>
          <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="close">✕ Close</button>
        </header>

        <nav class="flowquest-settingsTabs" role="tablist">
          <button type="button" role="tab" aria-selected="${this.tab === 'global'}"
            class="flowquest-settingsTab ${this.tab === 'global' ? 'is-active' : ''}"
            data-action="tab" data-tab="global">🌐 Global</button>
          <button type="button" role="tab" aria-selected="${this.tab === 'notebook'}"
            class="flowquest-settingsTab ${this.tab === 'notebook' ? 'is-active' : ''}"
            data-action="tab" data-tab="notebook">📓 This notebook</button>
        </nav>

        <div class="flowquest-settingsBody">
          ${this.tab === 'global' ? this.renderGlobalTab() : this.renderNotebookTab()}
        </div>
      </div>
    `;

    this.host.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
      element.onclick = event => {
        event.stopPropagation();
        const action = element.dataset.action;
        if (action === 'close') {
          this.close();
          return;
        }
        if (action === 'tab') {
          const next = (element.dataset.tab as 'global' | 'notebook') ?? this.tab;
          this.tab = next;
          this.wipeConfirm = false;
          this.render();
          return;
        }
        if (action === 'save') {
          void this.save();
          return;
        }
        if (action === 'difficulty') {
          const level = element.dataset.level as DifficultyLevel;
          if (level) void this.setDifficulty(level);
          return;
        }
        if (action === 'wipe-confirm') {
          this.wipeScope = (element.dataset.scope as 'notebook' | 'global') ?? 'notebook';
          this.wipeConfirm = true;
          this.render();
          return;
        }
        if (action === 'wipe-cancel') {
          this.wipeConfirm = false;
          this.render();
          return;
        }
        if (action === 'wipe-apply') {
          void this.wipe();
        }
      };
    });

    const modelInput = this.host.querySelector<HTMLInputElement>('input[data-field="model"]');
    if (modelInput) {
      modelInput.oninput = event => {
        this.formModel = (event.currentTarget as HTMLInputElement).value;
      };
    }
    const baseUrlInput = this.host.querySelector<HTMLInputElement>('input[data-field="baseUrl"]');
    if (baseUrlInput) {
      baseUrlInput.oninput = event => {
        this.formBaseUrl = (event.currentTarget as HTMLInputElement).value;
      };
    }
    const apiKeyInput = this.host.querySelector<HTMLInputElement>('input[data-field="apiKey"]');
    if (apiKeyInput) {
      apiKeyInput.oninput = event => {
        this.formApiKey = (event.currentTarget as HTMLInputElement).value;
      };
    }

    // Favorite-model chips
    this.host.querySelectorAll<HTMLElement>('[data-favorite]').forEach(element => {
      element.onclick = event => {
        event.stopPropagation();
        const value = element.dataset.favorite;
        if (value) {
          this.formModel = value;
          this.render();
        }
      };
    });
  }

  private renderGlobalTab(): string {
    if (this.loading && !this.settings) {
      return '<div class="flowquest-dim">Loading settings…</div>';
    }
    const settings = this.settings;
    const progressState = this.callbacks.getState();
    const level = progressState?.level ?? 1;
    const xp = progressState?.xpTotal ?? 0;
    const storage = settings?.apiKeyStorage ?? 'none';
    const keychainAvailable = Boolean(settings?.keychainAvailable);

    const apiKeyHint = settings?.apiKeySet
      ? `Currently set (${escapeHtml(settings.apiKeyPreview || 'hidden')}). Leave blank to keep it; type a new value to replace.`
      : 'No key on file yet. Paste one below to enable LLM features.';

    const storageNote = (() => {
      if (storage === 'keychain') {
        return `<div class="flowquest-dim flowquest-storageNote is-secure">🔐 Stored in your OS keychain. Not on disk.</div>`;
      }
      if (storage === 'file') {
        return `<div class="flowquest-dim flowquest-storageNote is-warn">⚠️ Stored in <code>~/.flowquest/settings.json</code> (mode 0600). Install <code>keyring</code> with a usable backend (e.g. <code>libsecret</code> on Linux) to move it to your OS keychain.</div>`;
      }
      if (storage === 'env') {
        return `<div class="flowquest-dim flowquest-storageNote">From environment / <code>.env</code>. Saving here will move it to ${
          keychainAvailable ? 'your OS keychain' : '<code>settings.json</code>'
        }.</div>`;
      }
      return `<div class="flowquest-dim flowquest-storageNote">${
        keychainAvailable
          ? 'Saving will store the key in your OS keychain.'
          : 'Saving will store the key in <code>~/.flowquest/settings.json</code> (mode 0600). Install a keyring backend for stronger storage.'
      }</div>`;
    })();
    const favorites = settings?.favoriteModels ?? [];
    const fileLine = settings?.settingsFile
      ? `Stored in ${escapeHtml(settings.settingsFile)}`
      : settings?.envFile
        ? `Reading from ${escapeHtml(settings.envFile)} (saving here will move the values to ~/.flowquest/settings.json).`
        : 'No settings file yet — saving will create one.';

    return `
      <section class="flowquest-settingsSection">
        <div class="flowquest-eyebrow">Endpoint</div>
        <p class="flowquest-dim">These apply to every notebook FlowQuest opens on this server.</p>

        <label class="flowquest-formLabel" for="fq-model">Model</label>
        <input id="fq-model" class="flowquest-formInput" type="text" data-field="model"
          placeholder="meta-llama/Llama-3.1-8B-Instruct"
          value="${escapeHtml(this.formModel)}" />
        ${
          favorites.length
            ? `<div class="flowquest-formChips">${favorites
                .map(
                  (m: string) =>
                    `<button type="button" class="flowquest-chipMini" data-favorite="${escapeHtml(
                      m
                    )}">${escapeHtml(m)}</button>`
                )
                .join('')}</div>`
            : ''
        }

        <label class="flowquest-formLabel" for="fq-base-url">Base URL</label>
        <input id="fq-base-url" class="flowquest-formInput" type="text" data-field="baseUrl"
          placeholder="https://router.huggingface.co/v1"
          value="${escapeHtml(this.formBaseUrl)}" />

        <label class="flowquest-formLabel" for="fq-api-key">API key</label>
        <input id="fq-api-key" class="flowquest-formInput" type="password" data-field="apiKey"
          placeholder="hf_..."
          value="${escapeHtml(this.formApiKey)}" />
        <div class="flowquest-dim">${apiKeyHint}</div>
        ${storageNote}

        <div class="flowquest-actionsRow">
          <button type="button" class="flowquest-btn flowquest-btn-primary" data-action="save"
            ${this.saving ? 'disabled' : ''}>${
              this.saving ? inlineSpinnerHtml('Saving…') : 'Save settings'
            }</button>
        </div>
        <div class="flowquest-dim">${fileLine}</div>
      </section>

      <section class="flowquest-settingsSection flowquest-settingsDanger">
        <div class="flowquest-eyebrow">Reset progress</div>
        <p class="flowquest-dim">
          XP and levels are <strong>global</strong> — shared across every
          notebook. You're currently <strong>Lv ${level}</strong> with
          <strong>${xp} XP</strong>.
        </p>
        <div class="flowquest-statRow">
          <span class="flowquest-pill flowquest-pill-muted">Lv ${level}</span>
          <span class="flowquest-pill flowquest-pill-muted">${xp} XP total</span>
        </div>
        ${
          this.wipeConfirm && this.wipeScope === 'global'
            ? `
              <div class="flowquest-confirmRow">
                <span>Reset ALL global XP and levels? This cannot be undone.</span>
                <button type="button" class="flowquest-btn flowquest-btn-danger" data-action="wipe-apply">Yes, reset everything</button>
                <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="wipe-cancel">Cancel</button>
              </div>
            `
            : `<div class="flowquest-actionsRow">
                <button type="button" class="flowquest-btn flowquest-btn-danger" data-action="wipe-confirm" data-scope="global">🧹 Reset all XP &amp; levels</button>
              </div>`
        }
      </section>
    `;
  }

  private renderNotebookTab(): string {
    const state = this.callbacks.getState();
    const currentDifficulty = state?.difficulty ?? 'medium';

    const difficultyHtml = DIFFICULTY_OPTIONS.map(option => {
      const active = option.value === currentDifficulty;
      return `
        <button type="button"
          class="flowquest-difficulty ${active ? 'is-active' : ''}"
          data-action="difficulty"
          data-level="${escapeHtml(option.value)}"
        >
          <span class="flowquest-difficultyIcon">${escapeHtml(option.icon)}</span>
          <span class="flowquest-difficultyLabel">${escapeHtml(option.label)}</span>
          <span class="flowquest-difficultyBlurb">${escapeHtml(option.blurb)}</span>
        </button>
      `;
    }).join('');

    return `
      <section class="flowquest-settingsSection">
        <div class="flowquest-eyebrow">Difficulty (this notebook)</div>
        <p class="flowquest-dim">
          Affects every LLM call for this notebook: explanations, quiz wording,
          and reflective questions. Stored in this notebook's metadata.
        </p>
        <div class="flowquest-difficultyGrid">${difficultyHtml}</div>
      </section>

      <section class="flowquest-settingsSection flowquest-settingsDanger">
        <div class="flowquest-eyebrow">Clear this notebook</div>
        <p class="flowquest-dim">
          Clears this notebook's checkpoints (missions, quizzes, reflections) so
          they can be re-earned. Your global XP and levels stay untouched — reset
          those from the <strong>Global</strong> tab.
        </p>
        ${
          this.wipeConfirm && this.wipeScope === 'notebook'
            ? `
              <div class="flowquest-confirmRow">
                <span>Clear this notebook's checkpoints so they can be re-earned? Your global XP stays.</span>
                <button type="button" class="flowquest-btn flowquest-btn-danger" data-action="wipe-apply">Yes, clear notebook</button>
                <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="wipe-cancel">Cancel</button>
              </div>
            `
            : `<div class="flowquest-actionsRow">
                <button type="button" class="flowquest-btn flowquest-btn-ghost" data-action="wipe-confirm" data-scope="notebook">↩️ Clear this notebook's checkpoints</button>
              </div>`
        }
      </section>
    `;
  }
}
