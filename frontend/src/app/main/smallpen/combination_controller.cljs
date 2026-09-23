;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.combination-controller
  ;; DSE-R25: the floating Workbench Combination controller. It exists ONLY
  ;; on the generated Design System page, floats in a viewport corner (canvas
  ;; zoom never scales it, it never enters the global toolbar and never
  ;; appears on ordinary pages), and lists every Workbench Combination the
  ;; projection materialized. FOCUSING a combination selects its band shell
  ;; and zooms the viewport — a pure observation action: no canonical write,
  ;; no hiding/unloading of the other combinations, no change to the
  ;; project's Current Combination. The explicit "设为当前" action IS a real
  ;; canonical edit (set-active-token-themes) and is labeled as such.
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [app.main.refs :as refs]
   [app.main.smallpen.dse :as dse]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(defn- combination-shapes
  "The band shells the panorama projected, in board order. Each carries its
  combination id, label and the theme paths (group/name) of its selection."
  [objects]
  (->> (vals objects)
       (keep (fn [shape]
               (let [pd (some-> shape :plugin-data :smallpen)]
                 (when-let [combo-id (get pd "design-system-combination")]
                   {:id (:id shape)
                    :combo-id combo-id
                    :label (get pd "design-system-combination-label" combo-id)
                    :themes (try
                              (js->clj (js/JSON.parse
                                        (get pd "design-system-combination-themes" "[]")))
                              (catch :default _ []))}))))
       (vec)))

(defn focus-combination
  "Observation only: select the band shell and zoom to it. Emits no commit;
  the canonical tree is untouched and every other combination stays on the
  canvas and in the layers tree."
  [shell-id]
  (st/emit! (dws/select-shapes (into (d/ordered-set) [shell-id]))
            dwz/zoom-to-selected-shape))

(defn set-current-combination
  "The explicit EDIT action: writes the project's Current Combination via
  the ordinary change pipeline (set-active-token-themes, with automatic
  undo of the previous active theme paths). Deliberately separated from
  focus/observation so the two semantics never mix (R26)."
  [{:keys [themes]}]
  (ptk/reify ::set-current-combination
    ptk/WatchEvent
    (watch [it state _]
      (when (seq themes)
        (let [data    (dsh/lookup-file-data state)
              changes (-> (pcb/empty-changes it)
                          (pcb/with-library-data data)
                          (pcb/set-active-token-themes (set themes)))]
          (rx/of (dch/commit-changes changes)))))))

(mf/defc controller*
  []
  (let [file       (mf/deref refs/file)
        page-id    (mf/use-ctx ctx/current-page-id)
        page       (get-in file [:data :pages-index page-id])
        visible?   (dse/design-system-page? page)
        objects    (or (get-in file [:data :pages-index page-id :objects]) {})
        combos     (combination-shapes objects)
        collapsed? (mf/use-state false)]

    (when visible?
      [:div {:data-testid "dse-combination-controller"
             :style #js {:position "absolute"
                         :top "16px"
                     ;; Keep clear of the right options sidebar (318px) so
                     ;; the panel never overlaps it.
                         :right "344px"
                         :zIndex 5
                         :color "var(--color-foreground-primary)"
                         :background "var(--color-background-primary)"
                         :border "1px solid var(--color-background-quaternary)"
                         :borderRadius "8px"
                         :boxShadow "0 4px 16px rgba(15, 23, 42, 0.12)"
                         :padding "10px 12px"
                         :fontSize "12px"
                         :minWidth "220px"
                         :maxWidth "300px"}}
       [:div {:style #js {:display "flex" :alignItems "center" :gap "8px"
                          :marginBottom (if @collapsed? "0" "6px")}}
        [:span {:style #js {:fontWeight "600"}}
         "Workbench 组合"]
        [:span {:style #js {:color "var(--color-foreground-secondary)"}}
         (str (count combos) " 个已展开")]
        [:button {:data-testid "dse-combination-toggle"
                  :on-click #(swap! collapsed? not)
                  :style #js {:marginLeft "auto" :cursor "pointer"
                              :padding "1px 8px"}}
         (if @collapsed? "展开" "收起")]]
       (when-not @collapsed?
         (if (seq combos)
           [:div
            [:div {:data-testid "dse-combination-hint"
                   :style #js {:color "var(--color-foreground-secondary)" :marginBottom "6px"}}
             "所有有效组合已并列在画布上；聚焦只是定位视图，不会隐藏其他组合。"]
            [:div {:style #js {:display "flex" :flexDirection "column" :gap "6px"}}
             (for [combo combos]
               ^{:key (str (:id combo))}
               [:div {:data-testid "dse-combination-row"
                      :style #js {:display "flex" :alignItems "center" :gap "6px"}}
                [:span {:style #js {:flex "1" :fontWeight "500"}}
                 (:label combo)]
                [:button {:data-testid "dse-combination-focus"
                          :on-click #(focus-combination (:id combo))
                          :style #js {:cursor "pointer" :padding "2px 8px"}}
                 "聚焦"]
                [:button {:data-testid "dse-combination-set-current"
                          :title (str "把项目当前组合切换为："
                                      (str/join "、" (:themes combo)))
                          :on-click #(st/emit! (set-current-combination
                                                {:themes (:themes combo)}))
                          :style #js {:cursor "pointer" :padding "2px 8px"}}
                 "设为当前"]])]]
           [:div {:data-testid "dse-combination-empty"
                  :style #js {:color "var(--color-foreground-secondary)"}}
            "当前包没有声明 Workbench Combination（无 Token Domain/主题）。"]))])))
