
const action = (fields, example, purpose) => ({ fields, example, purpose });
export const THEME_INTENT_ACTIONS = Object.freeze({
  "add-group": action(
    ["group", "setIds?"],
    { action: "add-group", group: "Brand" },
    "Create a real Group/Default set and paired theme, like the App",
  ),
  "add-option": action(
    ["group", "name", "source?"],
    { action: "add-option", group: "Brand", name: "Other" },
    "Copy the group's default option into an independent set; source optionally names another option",
  ),
  "set-default": action(
    ["group", "name"],
    { action: "set-default", group: "Brand", name: "Other" },
    "Change the project default without changing the App's active selection",
  ),
  "rename-group": action(
    ["group", "name"],
    { action: "rename-group", group: "Brand", name: "Identity" },
    "Rename a group and its matching set paths, preserving identities and values",
  ),
  "rename-option": action(
    ["group", "name", "newName"],
    {
      action: "rename-option",
      group: "Brand",
      name: "Other",
      newName: "Alternate",
    },
    "Rename an option and its own set, preserving references and default",
  ),
  "delete-option": action(
    ["group", "name"],
    { action: "delete-option", group: "Brand", name: "Other" },
    "Remove an option and its unshared set; referenced Tokens prevent deletion",
  ),
  "delete-group": action(
    ["group"],
    { action: "delete-group", group: "Brand" },
    "Remove a group and its unshared sets; referenced Tokens prevent deletion",
  ),
});

