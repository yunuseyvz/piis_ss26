/**
 * React settings modal for FlowQuest.
 *
 * Two tabs: global endpoint configuration and per-notebook difficulty/wipe.
 * Reads its own data and calls store actions for mutations.
 */

import { useCallback, useEffect, useState } from 'react';

import { difficultyIcon } from '../icons';
import type { DifficultyLevel, GlobalSettings, QuestState } from '../types';
import { toFriendlyError } from '../uiFeedback';
import { useNotebookState } from '../state/hooks';
import { FlowQuestStore } from '../state';
import { ErrorBlock, Icon, Spinner } from './shared';

const DIFFICULTY_OPTIONS: Array<{ value: DifficultyLevel; label: string; blurb: string }> = [
  {
    value: 'easy',
    label: 'Easy',
    blurb: 'Beginner-friendly explanations, gentle quizzes, generous baseline.'
  },
  {
    value: 'medium',
    label: 'Medium',
    blurb: 'Practitioner-level depth and balanced grading.'
  },
  {
    value: 'hard',
    label: 'Hard',
    blurb: 'Senior-reviewer mode. Strict baseline, sharp quizzes.'
  }
];

interface SettingsModalProps {
  isOpen: boolean;
  initialTab?: 'global' | 'notebook';
  onClose: () => void;
  store: FlowQuestStore;
  getCurrentNotebookState: () => QuestState;
  setDifficulty: (level: DifficultyLevel) => void;
  flashToast: (message: string) => void;
  onFreshStart: () => void | Promise<void>;
}

export function SettingsModal({
  isOpen,
  initialTab = 'global',
  onClose,
  store,
  getCurrentNotebookState,
  setDifficulty,
  flashToast,
  onFreshStart
}: SettingsModalProps): JSX.Element | null {
  const [tab, setTab] = useState<'global' | 'notebook'>(initialTab);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [formModel, setFormModel] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [freshStartConfirm, setFreshStartConfirm] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await store.loadSettings();
      setSettings(response);
      setFormModel(response.model);
      setFormBaseUrl(response.baseUrl);
      setFormApiKey('');
    } catch (error) {
      setLoadError(error);
      flashToast(`Could not load settings: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [store, flashToast]);

  // B9 fix: loadSettings is now in the dependency array.
  useEffect(() => {
    if (isOpen) {
      setTab(initialTab);
      void loadSettings();
    }
  }, [isOpen, initialTab, loadSettings]);

  const save = async () => {
    setSaving(true);
    try {
      const payload: { model: string; baseUrl: string; apiKey?: string } = {
        model: formModel,
        baseUrl: formBaseUrl
      };
      if (formApiKey.trim()) {
        payload.apiKey = formApiKey.trim();
      }
      const response = await store.saveSettings(payload);
      setSettings(response);
      setFormModel(response.model);
      setFormBaseUrl(response.baseUrl);
      setFormApiKey('');
      await store.checkEndpointStatus();
      flashToast('Settings saved.');
    } catch (error) {
      flashToast(`Save failed: ${toFriendlyError(error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDifficulty = (level: DifficultyLevel) => {
    setDifficulty(level);
    flashToast(`Difficulty set to ${level}.`);
  };

  if (!isOpen) {
    return null;
  }

  const activeNotebookPath = getCurrentNotebookState()?.notebookPath ?? '';
  const progressState = useNotebookState(store, activeNotebookPath).state;

  return (
    <div className="flowquest-settingsHost">
      <div className="flowquest-settingsBackdrop" onClick={onClose} />
      <div className="flowquest-settingsModal flowquest" role="dialog" aria-modal="true">
        <header className="flowquest-settingsHeader">
          <div className="flowquest-settingsHeading">
            <span className="flowquest-settingsIcon">
              <Icon name="settings" size={20} />
            </span>
            <div>
              <div className="flowquest-cardTitle">FlowQuest Settings</div>
              <div className="flowquest-dim">Global model + per-notebook quest options.</div>
            </div>
          </div>
          <div className="flowquest-settingsHeaderActions">

            <button
              type="button"
              className="flowquest-btn flowquest-btn-ghost"
              onClick={onClose}
            >
              <Icon name="close" /> Close
            </button>
          </div>
        </header>

          <nav className="flowquest-settingsTabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'global'}
              className={`flowquest-settingsTab ${tab === 'global' ? 'is-active' : ''}`}
              onClick={() => {
                setTab('global');
              }}
            >
              <Icon name="globe" /> Global
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'notebook'}
              className={`flowquest-settingsTab ${tab === 'notebook' ? 'is-active' : ''}`}
              onClick={() => {
                setTab('notebook');
              }}
            >
              <Icon name="contextNotebook" /> This notebook
            </button>
          </nav>

          <div className="flowquest-settingsBody">
            {tab === 'global' ? (
              <GlobalTab
                settings={settings}
                loading={loading}
                loadError={loadError}
                formModel={formModel}
                formBaseUrl={formBaseUrl}
                formApiKey={formApiKey}
                saving={saving}
                onModelChange={setFormModel}
                onBaseUrlChange={setFormBaseUrl}
                onApiKeyChange={setFormApiKey}
                onSave={() => void save()}
                freshStartConfirm={freshStartConfirm}
                onFreshStartConfirm={() => setFreshStartConfirm(true)}
                onFreshStartCancel={() => setFreshStartConfirm(false)}
                onFreshStart={onFreshStart}
              />
            ) : (
              <NotebookTab
                difficulty={progressState?.difficulty ?? 'medium'}
                onDifficulty={handleDifficulty}
              />
            )}
          </div>
        </div>
      </div>
  );
}




function GlobalTab({
  settings,
  loading,
  loadError,
  formModel,
  formBaseUrl,
  formApiKey,
  saving,
  onModelChange,
  onBaseUrlChange,
  onApiKeyChange,
  onSave,
  freshStartConfirm,
  onFreshStartConfirm,
  onFreshStartCancel,
  onFreshStart
}: {
  settings: GlobalSettings | null;
  loading: boolean;
  loadError: unknown;
  formModel: string;
  formBaseUrl: string;
  formApiKey: string;
  saving: boolean;
  onModelChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
  freshStartConfirm: boolean;
  onFreshStartConfirm: () => void;
  onFreshStartCancel: () => void;
  onFreshStart: () => void;
}): JSX.Element {
  if (loading && !settings) {
    return (
      <section className="flowquest-settingsSection">
        <div className="flowquest-dim">Loading settings…</div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="flowquest-settingsSection">
        <ErrorBlock error={loadError} onRetry={() => window.location.reload()} />
      </section>
    );
  }

  const storage = settings?.apiKeyStorage ?? 'none';
  const keychainAvailable = Boolean(settings?.keychainAvailable);
  const apiKeyHint = settings?.apiKeySet
    ? `Currently set (${settings.apiKeyPreview || 'hidden'}). Leave blank to keep it; type a new value to replace.`
    : 'No key on file yet. Paste one below to enable LLM features.';

  const fileLine = settings?.settingsFile
    ? `Stored in ${settings.settingsFile}`
    : settings?.envFile
      ? `Reading from ${settings.envFile} (saving here will move the values to ~/.flowquest/settings.json).`
      : 'No settings file yet — saving will create one.';

  return (
    <>
      <section className="flowquest-settingsSection">
        <div className="flowquest-eyebrow">Endpoint</div>
        <p className="flowquest-dim">
          These apply to every notebook FlowQuest opens on this server.
        </p>

        <label className="flowquest-formLabel" htmlFor="fq-model">
          Model
        </label>
        <input
          id="fq-model"
          className="flowquest-formInput"
          type="text"
          placeholder="meta-llama/Llama-3.1-8B-Instruct"
          value={formModel}
          onChange={e => onModelChange(e.target.value)}
        />
        {settings && settings.favoriteModels.length > 0 && (
          <div className="flowquest-formChips">
            {settings.favoriteModels.map(m => (
              <button key={m} type="button" className="flowquest-chipMini" onClick={() => onModelChange(m)}>
                {m}
              </button>
            ))}
          </div>
        )}

        <label className="flowquest-formLabel" htmlFor="fq-base-url">
          Base URL
        </label>
        <input
          id="fq-base-url"
          className="flowquest-formInput"
          type="text"
          placeholder="https://router.huggingface.co/v1"
          value={formBaseUrl}
          onChange={e => onBaseUrlChange(e.target.value)}
        />

        <label className="flowquest-formLabel" htmlFor="fq-api-key">
          API key
        </label>
        <input
          id="fq-api-key"
          className="flowquest-formInput"
          type="password"
          placeholder="hf_..."
          value={formApiKey}
          onChange={e => onApiKeyChange(e.target.value)}
        />
        <div className="flowquest-dim">{apiKeyHint}</div>
        <StorageNote storage={storage} keychainAvailable={keychainAvailable} />

        <div className="flowquest-actionsRow">
          <button
            type="button"
            className="flowquest-btn flowquest-btn-primary"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? <Spinner label="Saving…" inline /> : 'Save settings'}
          </button>
        </div>
        <div className="flowquest-dim">{fileLine}</div>
      </section>



      <section className="flowquest-settingsSection flowquest-settingsDanger">
        <div className="flowquest-eyebrow">Fresh start</div>
        <p className="flowquest-dim">
          Wipe the entire user profile — <strong>settings</strong> (model, base URL, API key)
          and <strong>all XP / level / award history</strong> — and clear every open notebook's
          FlowQuest metadata (difficulty, quizzes, chat) so FlowQuest starts completely
          from scratch on this machine. This cannot be undone.
        </p>
        {freshStartConfirm ? (
          <div className="flowquest-confirmRow">
            <span>Reset everything FlowQuest knows about you?</span>
            <button
              type="button"
              className="flowquest-btn flowquest-btn-danger"
              onClick={() => {
                onFreshStartCancel();
                void onFreshStart();
              }}
            >
              Yes, wipe everything
            </button>
            <button
              type="button"
              className="flowquest-btn flowquest-btn-ghost"
              onClick={onFreshStartCancel}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flowquest-actionsRow">
            <button
              type="button"
              className="flowquest-btn flowquest-btn-danger"
              onClick={onFreshStartConfirm}
            >
              <Icon name="refresh" /> Fresh start — wipe everything
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function StorageNote({
  storage,
  keychainAvailable
}: {
  storage: string;
  keychainAvailable: boolean;
}): JSX.Element {
  if (storage === 'keychain') {
    return (
      <div className="flowquest-dim flowquest-storageNote is-secure">
        <Icon name="auth" /> Stored in your OS keychain. Not on disk.
      </div>
    );
  }
  if (storage === 'file') {
    return (
      <div className="flowquest-dim flowquest-storageNote is-warn">
        <Icon name="warn" /> Stored in <code>~/.flowquest/settings.json</code> (mode 0600). Install{' '}
        <code>keyring</code> with a usable backend (e.g. <code>libsecret</code> on Linux) to move it to
        your OS keychain.
      </div>
    );
  }
  if (storage === 'env') {
    return (
      <div className="flowquest-dim flowquest-storageNote">
        From environment / <code>.env</code>. Saving here will move it to{' '}
        {keychainAvailable ? (
          'your OS keychain'
        ) : (
          <>
            <code>settings.json</code>
          </>
        )}
        .
      </div>
    );
  }
  return (
    <div className="flowquest-dim flowquest-storageNote">
      {keychainAvailable ? (
        'Saving will store the key in your OS keychain.'
      ) : (
        <>
          Saving will store the key in <code>~/.flowquest/settings.json</code> (mode 0600). Install a
          keyring backend for stronger storage.
        </>
      )}
    </div>
  );
}

interface NotebookTabProps {
  difficulty: DifficultyLevel;
  onDifficulty: (level: DifficultyLevel) => void;
}

function NotebookTab({
  difficulty,
  onDifficulty
}: NotebookTabProps): JSX.Element {
  return (
    <>
      <section className="flowquest-settingsSection">
        <div className="flowquest-eyebrow">Difficulty (this notebook)</div>
        <p className="flowquest-dim">
          Affects every LLM call for this notebook: explanations, quiz wording, and reflective
          questions. Stored in this notebook's metadata.
        </p>
        <div className="flowquest-difficultyGrid">
          {DIFFICULTY_OPTIONS.map(option => {
            const active = option.value === difficulty;
            return (
              <button
                key={option.value}
                type="button"
                className={`flowquest-difficulty ${active ? 'is-active' : ''}`}
                onClick={() => onDifficulty(option.value)}
              >
                <span
                  className="flowquest-difficultyIcon"
                  dangerouslySetInnerHTML={{ __html: difficultyIcon(option.value) }}
                />
                <span className="flowquest-difficultyLabel">{option.label}</span>
                <span className="flowquest-difficultyBlurb">{option.blurb}</span>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
