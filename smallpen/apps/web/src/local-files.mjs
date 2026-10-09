// This picker owns its dialog. File access and writes stay on the local service.
async function request(route, body) {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error?.message || "Cannot open this folder.");
  return value;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const css = `
dialog.smallpen-local-picker{color-scheme:light dark;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:12px;padding:24px;inline-size:min(820px,calc(100vw - 48px));max-block-size:85vh;font:15px/1.5 system-ui,sans-serif}
dialog.smallpen-local-picker::backdrop{background:#0008}
.smallpen-local-picker h2{margin:0 0 16px;font-size:22px}
.smallpen-local-picker label{display:block;margin-block:12px 6px}
.smallpen-local-picker input{box-sizing:border-box;inline-size:100%;padding:10px;border:1px solid GrayText;border-radius:6px;background:Field;color:FieldText;font:inherit}
.smallpen-local-picker button{font:inherit;padding:8px 14px;border:1px solid GrayText;border-radius:6px;cursor:pointer;background:ButtonFace;color:ButtonText}
.smallpen-local-picker button:disabled{opacity:.5;cursor:default}
.smallpen-local-picker .locations,.smallpen-local-picker footer{display:flex;gap:10px;margin-block:14px}
.smallpen-local-picker footer{justify-content:flex-end;margin-block-end:0}
.smallpen-local-picker .folders{block-size:340px;overflow:auto;border:1px solid GrayText;border-radius:6px;padding:4px}
.smallpen-local-picker .folders button{display:block;inline-size:100%;border:0;border-radius:4px;text-align:start;padding:9px 12px;overflow-wrap:anywhere}
.smallpen-local-picker .folders button:hover{background:Highlight;color:HighlightText}
.smallpen-local-picker .status{min-block-size:24px;overflow-wrap:anywhere;margin-block:12px 0}
`;

export function choosePackage(action) {
  if (!["open", "create"].includes(action))
    return Promise.reject(new Error("Unknown file action."));
  const chinese = (
    document.documentElement.lang ||
    navigator.language ||
    "en"
  ).startsWith("zh");
  const words = chinese
    ? {
        open: "打开设计包",
        create: "新建设计包",
        path: "文件夹",
        name: "名称",
        home: "个人目录",
        up: "上一级",
        go: "前往",
        cancel: "取消",
        loading: "加载中…",
        empty: "没有子文件夹",
        many: "文件夹较多，可以直接输入路径。",
        select: "选择 .smallpen 文件夹。",
      }
    : {
        open: "Open Package",
        create: "New Package",
        path: "Folder",
        name: "Name",
        home: "Home",
        up: "Up",
        go: "Go",
        cancel: "Cancel",
        loading: "Loading…",
        empty: "No subfolders",
        many: "Many folders. You can enter a path directly.",
        select: "Select a .smallpen folder.",
      };
  return new Promise((resolve) => {
    const dialog = element("dialog", "", "smallpen-local-picker");
    const style = element("style", css);
    dialog.append(style, element("h2", words[action]));
    const path = element("input");
    path.id = "smallpen-local-folder";
    const pathLabel = element("label", words.path);
    pathLabel.htmlFor = path.id;
    dialog.append(pathLabel, path);
    const locations = element("div", "", "locations");
    const up = element("button", words.up);
    const home = element("button", words.home);
    const go = element("button", words.go);
    locations.append(up, home, go);
    const folders = element("div", "", "folders");
    const status = element("p", "", "status");
    status.setAttribute("role", "status");
    dialog.append(locations, folders);
    const name = element("input");
    if (action === "create") {
      name.id = "smallpen-local-name";
      name.value = "Untitled.smallpen";
      const label = element("label", words.name);
      label.htmlFor = name.id;
      dialog.append(label, name);
    }
    const footer = element("footer");
    const cancel = element("button", words.cancel);
    const submit = element("button", words[action]);
    footer.append(cancel, submit);
    dialog.append(status, footer);
    let listing;
    let query = 0;
    let pending = false;
    let saving = false;
    const update = () => {
      submit.disabled =
        pending ||
        saving ||
        !listing ||
        (action === "open"
          ? !listing.path.toLowerCase().endsWith(".smallpen")
          : !name.value.trim());
    };
    const close = (result = null) => {
      query++;
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    const browse = async (target) => {
      if (saving) return;
      const current = ++query;
      listing = undefined;
      pending = true;
      status.textContent = words.loading;
      update();
      try {
        const value = await request(
          "/local/directories",
          target === undefined ? {} : { path: target },
        );
        if (current !== query) return;
        listing = value;
        path.value = value.path;
        folders.replaceChildren();
        for (const entry of value.entries) {
          const button = element(
            "button",
            `${entry.package ? "▣" : "▸"} ${entry.name}`,
          );
          button.addEventListener("click", () => browse(entry.path));
          folders.append(button);
        }
        if (!value.entries.length) folders.append(element("p", words.empty));
        up.disabled = value.parent === value.path;
        status.textContent = value.truncated
          ? words.many
          : action === "open" && !value.path.toLowerCase().endsWith(".smallpen")
            ? words.select
            : "";
      } catch (error) {
        if (current === query) status.textContent = error.message;
      } finally {
        if (current === query) {
          pending = false;
          update();
        }
      }
    };
    go.addEventListener("click", () => browse(path.value));
    path.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void browse(path.value);
      }
    });
    home.addEventListener("click", () => browse(listing?.home || "~"));
    up.addEventListener("click", () => {
      if (listing) void browse(listing.parent);
    });
    name.addEventListener("input", update);
    cancel.addEventListener("click", () => close());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!cancel.disabled) close();
    });
    submit.addEventListener("click", async () => {
      if (submit.disabled) return;
      let locator = listing.path;
      if (action === "create") {
        const value = name.value.trim();
        if (/[\\/\x00-\x1f]/.test(value) || value === "." || value === "..") {
          status.textContent = chinese
            ? "请输入文件夹名称。"
            : "Enter a folder name.";
          return;
        }
        locator += `${locator.endsWith("/") || locator.endsWith("\\") ? "" : "/"}${value.toLowerCase().endsWith(".smallpen") ? value : value + ".smallpen"}`;
      }
      saving = true;
      update();
      cancel.disabled = true;
      try {
        close(
          await request(
            `/desktop/${action === "open" ? "open" : "create"}-package`,
            { locator },
          ),
        );
      } catch (error) {
        status.textContent = error.message;
        saving = false;
        cancel.disabled = false;
        update();
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    void browse();
  });
}
