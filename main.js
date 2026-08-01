const { Plugin, PluginSettingTab, Setting, Modal, Notice, TFile, normalizePath } = require("obsidian");

const DEFAULTS = {
  endpoint: "http://127.0.0.1:8791",
  token: "",
  limit: 30,
  pullFolder: "Pulled from Archive"
};

class SearchModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.query = "";
    this.results = [];
    this.timer = null;
  }

  onOpen() {
    this.contentEl.addClass("gbrain-archive-modal");
    this.contentEl.createEl("h2", { text: "GBrain Archive Bridge" });
    const input = this.contentEl.createEl("input", {
      type: "search",
      placeholder: "Search active vault and legacy archive..."
    });
    input.addEventListener("input", () => {
      this.query = input.value.trim();
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), 250);
    });
    input.focus();
    this.status = this.contentEl.createDiv({ cls: "gbrain-archive-status" });
    this.list = this.contentEl.createDiv({ cls: "gbrain-archive-results" });
    this.render();
  }

  async run() {
    this.status.setText("Searching...");
    try {
      const [local, archive] = await Promise.all([
        this.plugin.searchLocal(this.query),
        this.plugin.searchArchive(this.query)
      ]);
      this.results = [...local, ...archive];
      this.render();
      this.status.setText(`${local.length} active-vault result(s), ${archive.length} archive result(s)`);
    } catch (error) {
      this.status.setText(`Search failed: ${error.message}`);
    }
  }

  render() {
    this.list.empty();
    if (!this.results.length) {
      this.list.createDiv({ text: "Type a search term to search both sources." });
      return;
    }
    for (const result of this.results) {
      const row = this.list.createDiv({ cls: "gbrain-archive-result" });
      row.createEl("strong", { text: result.title || result.path });
      row.createDiv({ text: `${result.source}: ${result.path}`, cls: "gbrain-archive-path" });
      if (result.snippet) row.createDiv({ text: result.snippet, cls: "gbrain-archive-snippet" });
      const button = row.createEl("button", { text: result.source === "archive" ? "Pull and open" : "Open" });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          if (result.source === "archive") {
            const pulled = await this.plugin.pullArchive(result.id);
            if (typeof pulled.content === "string") {
              await this.plugin.writePulledFile(pulled.vault_path, pulled.content);
            }
            await this.app.workspace.openLinkText(pulled.vault_path, "", false);
          } else {
            await this.app.workspace.openLinkText(result.path, "", false);
          }
          this.close();
        } catch (error) {
          new Notice(`GBrain Archive Bridge: ${error.message}`);
          button.disabled = false;
        }
      });
    }
  }

  onClose() {
    window.clearTimeout(this.timer);
    this.contentEl.empty();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GBrain Archive Bridge" });
    new Setting(containerEl).setName("GBrain API endpoint").setDesc("Use the server LAN address on laptop/iPhone; localhost only works on the server.")
      .addText(text => text.setPlaceholder(DEFAULTS.endpoint).setValue(this.plugin.settings.endpoint)
        .onChange(async value => { this.plugin.settings.endpoint = value.trim().replace(/\/$/, ""); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Bearer token").setDesc("The token stored in ~/.config/gbrain/api_token on the server.")
      .addText(text => text.setPlaceholder("Paste API token").setValue(this.plugin.settings.token)
        .onChange(async value => { this.plugin.settings.token = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Archive pull folder").setDesc("Destination inside the active vault.")
      .addText(text => text.setValue(this.plugin.settings.pullFolder)
        .onChange(async value => { this.plugin.settings.pullFolder = value.trim() || DEFAULTS.pullFolder; await this.plugin.saveSettings(); }));
  }
}

module.exports = class GBrainArchiveBridge extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addCommand({ id: "search-active-and-archive", name: "Search active vault and GBrain archive", callback: () => new SearchModal(this.app, this).open() });
    this.addRibbonIcon("archive", "Search active vault and GBrain archive", () => new SearchModal(this.app, this).open());
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  async searchLocal(query) {
    const q = query.toLowerCase();
    const files = this.app.vault.getMarkdownFiles();
    const results = [];
    for (const file of files) {
      const nameHit = !q || file.path.toLowerCase().includes(q);
      let snippet = "";
      if (!nameHit && q) {
        const text = (await this.app.vault.cachedRead(file)).slice(0, 120000);
        const index = text.toLowerCase().indexOf(q);
        if (index < 0) continue;
        snippet = text.slice(Math.max(0, index - 100), index + 300).replace(/\s+/g, " ");
      }
      results.push({ source: "active vault", title: file.basename, path: file.path, snippet });
      if (results.length >= this.settings.limit) break;
    }
    return results;
  }

  async searchArchive(query) {
    const data = await this.request(`/api/archive/search?q=${encodeURIComponent(query)}&limit=${this.settings.limit}`);
    return (data.results || []).map(item => ({ ...item, source: "archive", path: item.relpath }));
  }

  async pullArchive(id) {
    return this.request("/api/archive/pull", { method: "POST", body: { id, overwrite: true } });
  }

  async writePulledFile(path, content) {
    const normalized = normalizePath(path);
    const parts = normalized.split("/");
    let folder = "";
    for (const part of parts.slice(0, -1)) {
      folder = folder ? `${folder}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
    }
    await this.app.vault.adapter.write(normalized, content);
  }

  async request(path, options = {}) {
    if (!this.settings.token) throw new Error("Configure the GBrain API token in plugin settings");
    const response = await fetch(`${this.settings.endpoint}${path}`, {
      method: options.method || "GET",
      headers: { Authorization: `Bearer ${this.settings.token}`, "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json();
  }
};
