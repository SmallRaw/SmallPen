;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.edit-policy
  (:require
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace.shapes :as-alias dwsh]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [clojure.set :as set]
   [clojure.string :as str]))

(defn design-system-page?
  [page]
  (true? (get-in page [:plugin-data :smallpen "design-system-page"])))

(defn generated-page?
  "The Design System page and the native Components page are rebuilt from
  the Package on every load; neither is a Package page to rename, move or
  delete."
  [page]
  (or (design-system-page? page)
      (true? (get-in page [:plugin-data :smallpen "components-page"]))))

(defn current-page-locked?
  [state]
  (design-system-page?
   (get-in state [:files (:current-file-id state) :data :pages-index (:current-page-id state)])))

(defn source-shape?
  [shape]
  (= "source" (get-in shape [:plugin-data :smallpen "design-system"])))

(defn- read-only-source?
  "A Product's Design System page shows its Foundation's Token Cells; their
  source ref says they are read-only there."
  [shape]
  (some-> (get-in shape [:plugin-data :smallpen "design-system-ref"])
          (js/JSON.parse)
          (unchecked-get "readOnly")
          (true?)))

(defn shape-editable?
  "Edition mode (text, path) is limited to source shapes on DS pages, which
  also avoids a refused commit on every keystroke."
  [state shape]
  (or (not (current-page-locked? state))
      (and (source-shape? shape)
           (not (read-only-source? shape)))))

(defn- smallpen-file?
  "Only SmallPen projections carry file-level SmallPen plugin data, so every
  other file skips the per-change page lookup."
  [file]
  (some? (get-in file [:data :plugin-data :smallpen])))

(defn- change-page
  [pages change]
  (get pages (or (:page-id change)
                 (when (#{:mod-page :del-page :mov-page} (:type change)) (:id change))
                 (:main-instance-page change))))

(def ^:private derived-attributes
  #{:position-data :selrect :points :transform :transform-inverse})

;; Token propagation rewrites token-bound values and the layout reflow they
;; cause. On a DS page the reflowed geometry is a deterministic function of
;; the source tree (copies share the source node ids and parent-relative
;; layout), so it is bookkeeping, not a user move or resize.
(def ^:private propagation-geometry
  (into derived-attributes #{:x :y :width :height}))

;; Spacing tokens write these layout values; they are token applications,
;; not changes to the layout structure.
(def ^:private token-layout-attributes
  #{:layout-gap :layout-padding :layout-item-margin})

(defn- propagation?
  [origin]
  (= ::dwsh/update-shapes-buffer origin))

(defn- bookkeeping?
  [change derived]
  (or (= :reg-objects (:type change))
      (and (= :mod-obj (:type change))
           (every? #(contains? derived (:attr %)) (:operations change)))))

(defn- blocked-shape-change
  [pages propagation? change]
  (when-let [page (let [page (change-page pages change)]
                    (when (design-system-page? page) page))]
    (when-not (bookkeeping? change (if propagation? propagation-geometry derived-attributes))
      (let [shape (get-in page [:objects (:id change)])
            attrs (cond-> (set (map :attr (:operations change)))
                    propagation? (set/difference token-layout-attributes))]
        (cond
          (not= :mod-obj (:type change)) :structure
          (not (source-shape? shape)) :decoration
          (read-only-source? shape) :foundation
          (some #(or (#{:shapes :parent-id :frame-id :component-id :component-file
                        :component-root :main-instance :shape-ref} %)
                     (str/starts-with? (name (or % :none)) "layout")) attrs) :structure
          (and (some attrs [:x :y])
               (not (some attrs [:width :height]))) :position)))))

(defn- blocked-decoration-change
  "The labels of the Components page are generated: only renderer
  bookkeeping may touch them, never a user edit."
  [pages change]
  (let [page (change-page pages change)]
    (when (and (true? (get-in page [:plugin-data :smallpen "components-page"]))
               (not (bookkeeping? change derived-attributes))
               (some #(= "decoration"
                         (get-in page [:objects % :plugin-data :smallpen "components-page"]))
                     (into [(:id change) (:parent-id change)] (:shapes change))))
      :decoration)))

(def ^:private token-edit-types
  #{:set-token :set-token-set :set-token-theme :move-token-set
    :move-token-set-group :rename-token-set-group})

(defn- foundation-tokens
  "The runtime ids and set names of the Foundation token sets, themes and
  tokens a Product's token library shows (projection.cljs), or nil."
  [file]
  (when-let [value (get-in file [:data :plugin-data :smallpen "foundation-tokens"])]
    (let [{:keys [ids sets]} (js->clj (js/JSON.parse value) :keywordize-keys true)]
      {:ids (set ids) :sets (set sets)})))

(defn- foundation-token-change?
  [{:keys [ids sets]} change]
  (and (contains? token-edit-types (:type change))
       (or (some #(contains? ids (some-> (get change %) str)) [:id :set-id :token-id])
           (some (fn [path]
                   (let [name (str/join "/" path)]
                     (some #(or (= name %) (str/starts-with? % (str name "/"))) sets)))
                 (keep #(get change %) [:from-path :to-path :before-path :set-group-path])))))

(defn- blocked-change
  [pages foundation propagation? change]
  (cond
    (and (#{:mod-page :del-page :mov-page} (:type change))
         (generated-page? (change-page pages change)))
    :generated-page

    (and foundation (foundation-token-change? foundation change))
    :foundation

    :else
    (or (blocked-decoration-change pages change)
        (blocked-shape-change pages propagation? change))))

(defn commit-block-reason
  "Gate BEFORE the local commit, undo stack and persistence buffer. Reject
  the complete user action, never silently save half of a structural edit.
  Source-targeted creation remains valid even while the DS page is open.
  `origin` is the type of the event that built the changes."
  ([file changes]
   (commit-block-reason file changes nil))
  ([file changes origin]
   (when (smallpen-file? file)
     (let [pages        (get-in file [:data :pages-index])
           foundation   (when (some #(contains? token-edit-types (:type %)) changes)
                          (foundation-tokens file))
           propagation? (propagation? origin)]
       ;; Preserve renderer measurement commits: they update local text geometry
       ;; and are already accepted as canonical no-ops by the adapter.
       (some #(blocked-change pages foundation propagation? %) changes)))))

(defn- copied-shape?
  "Duplicate and paste mark each new shape's add-obj with the id it was
  copied from; an undo that restores a deleted shape does not."
  [change]
  (and (= :add-obj (:type change))
       (some? (:old-id change))
       (some? (get-in change [:obj :plugin-data :smallpen]))))

(def ^:private main-identity-keys
  "SmallPen plugin-data that only a component main carries."
  #{"component-id" "variant-id" "layout-offset"})

(defn- instantiated-copy?
  "Instantiating a component (an Assets drop, a variant switch) copies the
  main's shapes with their plugin-data, so the copy claims to be the main."
  [change]
  (let [obj (:obj change)]
    (and (= :add-obj (:type change))
         (not (:main-instance obj))
         (or (some? (:shape-ref obj))
             (some? (:component-id obj)))
         (some main-identity-keys
               (keys (get-in obj [:plugin-data :smallpen]))))))

(defn without-copied-identity
  "A copied or instantiated shape is a new Package node, but it carries the
  original's SmallPen plugin-data (node id, source refs, layout offset) until
  the next projection. Drop it so nothing resolves the copy to the original."
  [file changes]
  (let [copy? (some-fn copied-shape? instantiated-copy?)]
    (if (and (smallpen-file? file)
             (some copy? changes))
      (mapv (fn [change]
              (cond-> change
                (copy? change)
                (update-in [:obj :plugin-data] dissoc :smallpen)))
            changes)
      changes)))

(defn drawing-blocked?
  "Drawing tools (except comments) create shapes, which DS pages reject."
  [state tool]
  (and (not= tool :comments)
       (current-page-locked? state)))

(declare blocked-message)

(defn blocked-warning
  [reason]
  (ntf/warn (blocked-message reason)))

(defn unless-locked
  "Emit `event`, unless the current page is a DS page: keyboard moves there
  would be refused on every key press."
  [state event]
  (if (current-page-locked? state)
    (rx/empty)
    (rx/of event)))

(defn blocked-stream
  "Stream for an entry point refused before it starts: one warning on a DS
  page, nothing elsewhere."
  [state]
  (if (current-page-locked? state)
    (rx/of (blocked-warning :structure))
    (rx/empty)))

(defn blocked-message
  [reason]
  (case reason
    :decoration (tr "smallpen.design-system.blocked-decoration")
    :position (tr "smallpen.design-system.blocked-position")
    :generated-page (tr "smallpen.design-system.blocked-generated-page")
    :foundation (tr "smallpen.design-system.blocked-foundation")
    (tr "smallpen.design-system.blocked-structure")))
