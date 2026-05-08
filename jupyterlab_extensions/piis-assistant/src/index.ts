import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';

const PLUGIN_ID = 'jupyterlab-piis-assistant:plugin';
const COMMAND_FOCUS_SIDEBAR = 'jupyterlab-piis-assistant:focus-sidebar';
const SIDEBAR_ID = 'jupyterlab-piis-assistant:sidebar';

interface EndpointStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
  envFile: string;
  message: string;
}

interface ChatResponse {
  title: string;
  response: string;
  model: string;
}

const EMPTY_STATUS: EndpointStatus = {
  configured: false,
  model: 'Unavailable',
  baseUrl: 'Unavailable',
  envFile: 'not found',
  message: 'Status has not been loaded yet.'
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildUrl(path: string): string {
  const settings = ServerConnection.makeSettings();
  return new URL(path.replace(/^\//, ''), settings.baseUrl).toString();
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string; reason?: string };
    return payload.reason ?? payload.message ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const headers = new Headers(init.headers ?? undefined);

  if (init.method !== 'GET' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await ServerConnection.makeRequest(
    buildUrl(path),
    {
      ...init,
      headers
    },
    settings
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json() as Promise<T>;
}

class AssistantSidebar extends Widget {
  constructor() {
    super();
    this.id = SIDEBAR_ID;
    this.title.label = 'Assistant';
    this.title.caption = 'PIIS Assistant';
    this.title.closable = false;
    this.addClass('piisAssistant');
    this.render();
    void this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    this._meta = 'Checking endpoint configuration...';
    this.render();

    try {
      this._status = await requestJson<EndpointStatus>('piis-assistant/status', { method: 'GET' });
      this._meta = this._status.message;
    } catch (error) {
      this._status = {
        configured: false,
        model: 'Unavailable',
        baseUrl: 'Unavailable',
        envFile: 'not found',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
      this._meta = this._status.message;
    }

    this.render();
  }

  private render(): void {
    const disabled = !this._status.configured || this._phase === 'loading';
    const statusClass = this._status.configured ? 'is-live' : 'is-missing';
    const responseClass = this._phase === 'error' ? 'is-error' : '';

    this.node.innerHTML = `
      <div class="piisAssistant-shell">
        <section class="piisAssistant-hero">
          <div class="piisAssistant-eyebrow">PIIS Extension</div>
          <h2>Assistant Sidebar</h2>
          <p>A minimal extension surface: ask a question, send it to the configured HF endpoint, and read the response directly in JupyterLab.</p>
        </section>

        <section class="piisAssistant-card">
          <h3>Status</h3>
          <p>${escapeHtml(this._status.message)}</p>
          <div class="piisAssistant-statusRow">
            <span class="piisAssistant-pill ${statusClass}">${escapeHtml(
              this._status.configured ? 'configured' : 'missing'
            )}</span>
            <span class="piisAssistant-pill">${escapeHtml(this._status.model)}</span>
          </div>
          <div class="piisAssistant-meta">Base URL: ${escapeHtml(this._status.baseUrl)}<br />Env: ${escapeHtml(
            this._status.envFile
          )}</div>
        </section>

        <section class="piisAssistant-card">
          <h3>Prompt</h3>
          <p>Keep it simple for now. This sidebar sends only your prompt and returns the model response.</p>
          <textarea class="piisAssistant-textarea" placeholder="Ask the assistant anything...">${escapeHtml(
            this._prompt
          )}</textarea>
          <div class="piisAssistant-actions">
            <button class="piisAssistant-button" type="button" data-action="ask" ${
              disabled ? 'disabled' : ''
            }>Ask Assistant</button>
            <button class="piisAssistant-button is-secondary" type="button" data-action="clear">Clear</button>
            <button class="piisAssistant-button is-secondary" type="button" data-action="refresh">Refresh Status</button>
          </div>
          <div class="piisAssistant-chipRow">
            <button class="piisAssistant-chip" type="button" data-prompt="Summarize what this notebook is about.">Summarize notebook</button>
            <button class="piisAssistant-chip" type="button" data-prompt="What should I investigate next in this analysis?">Suggest next step</button>
            <button class="piisAssistant-chip" type="button" data-prompt="Explain a modeling choice I should review.">Review modeling</button>
          </div>
        </section>

        <section class="piisAssistant-card">
          <h3>${escapeHtml(this._responseTitle)}</h3>
          <div class="piisAssistant-response ${responseClass}">${escapeHtml(this._response)}</div>
          <div class="piisAssistant-meta">${escapeHtml(this._meta)}</div>
        </section>
      </div>
    `;

    const textarea = this.node.querySelector<HTMLTextAreaElement>('.piisAssistant-textarea');
    if (textarea) {
      textarea.oninput = event => {
        this._prompt = (event.currentTarget as HTMLTextAreaElement).value;
      };
    }

    this.node.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      button.onclick = () => {
        const action = button.dataset.action;
        if (action === 'ask') {
          void this.submitPrompt();
        }
        if (action === 'clear') {
          this._prompt = '';
          this._responseTitle = 'Response';
          this._response = 'Your model response will appear here.';
          this._meta = this._status.message;
          this._phase = 'idle';
          this.render();
        }
        if (action === 'refresh') {
          void this.refreshStatus();
        }
      };
    });

    this.node.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => {
      button.onclick = () => {
        const prompt = button.dataset.prompt ?? '';
        this._prompt = prompt;
        this.render();
      };
    });
  }

  private async submitPrompt(): Promise<void> {
    const prompt = this._prompt.trim();
    if (!prompt) {
      this._phase = 'error';
      this._responseTitle = 'Prompt required';
      this._response = 'Enter a prompt before sending a request.';
      this._meta = 'The sidebar only sends the text currently in the prompt box.';
      this.render();
      return;
    }

    this._phase = 'loading';
    this._responseTitle = 'Assistant is thinking';
    this._response = 'Waiting for the model response...';
    this._meta = 'Sending prompt to the server-side HF endpoint.';
    this.render();

    try {
      const response = await requestJson<ChatResponse>('piis-assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ prompt })
      });
      this._phase = 'ready';
      this._responseTitle = response.title;
      this._response = response.response;
      this._meta = `Model: ${response.model}`;
    } catch (error) {
      this._phase = 'error';
      this._responseTitle = 'Request failed';
      this._response = error instanceof Error ? error.message : 'Unknown error';
      this._meta = 'Check the root .env values and Jupyter server logs.';
    }

    this.render();
  }

  private _meta = 'Status has not been loaded yet.';
  private _phase: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private _prompt = 'Summarize what this project does.';
  private _response = 'Your model response will appear here.';
  private _responseTitle = 'Response';
  private _status: EndpointStatus = EMPTY_STATUS;
}

function activate(app: JupyterFrontEnd, palette: ICommandPalette): void {
  const sidebar = new AssistantSidebar();
  app.shell.add(sidebar, 'left', { rank: 880 });

  app.commands.addCommand(COMMAND_FOCUS_SIDEBAR, {
    label: 'PIIS: Focus Assistant Sidebar',
    execute: () => {
      app.shell.activateById(SIDEBAR_ID);
    }
  });

  palette.addItem({ command: COMMAND_FOCUS_SIDEBAR, category: 'PIIS Assistant' });
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Adds a minimal PIIS assistant sidebar to JupyterLab.',
  autoStart: true,
  requires: [ICommandPalette],
  activate
};

export default plugin;