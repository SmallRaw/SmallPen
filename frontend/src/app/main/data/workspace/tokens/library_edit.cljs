;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.tokens.library-edit
  (:require
   [app.main.smallpen.token-state :as spts]
   [app.common.data.macros :as dm]
   [app.common.files.changes :as cpc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.tokens :as cfo]
   [app.common.geom.point :as gpt]
   [app.common.logic.tokens :as clo]
   [app.common.path-names :as cpn]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.types.shape :as cts]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.event :as ev]
   [app.main.data.helpers :as dsh]
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.data.workspace.tokens.remapping :as remap]
   [app.util.i18n :refer [tr]]
   [app.util.storage :as storage]
   [beicon.v2.core :as rx]
   [clojure.set :as set]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(declare set-selected-token-set-id)

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TOKENS Getters
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn lookup-token-set
  ([state]
   (when-let [selected (dm/get-in state [:workspace-tokens :selected-token-set-id])]
     (lookup-token-set state selected)))
  ([state id]
   (some-> (dsh/lookup-tokens-lib state)
           (ctob/get-set id))))

(defn- copy-token-set
  [tokens-lib source-set-id copy-name]
  (when-let [source-set (ctob/get-set tokens-lib source-set-id)]
    (let [tokens (->> (ctob/get-tokens tokens-lib source-set-id)
                      vals
                      (map (fn [token]
                             (let [token' (-> (into {} token)
                                              (dissoc :id :modified-at)
                                              (ctob/make-token))]
                               [(:name token') token']))))]
      (ctob/make-token-set
       :name copy-name
       :description (ctob/get-description source-set)
       :tokens tokens))))

(defn- same-matrix-name?
  [left right]
  (= (str/lower (or left ""))
     (str/lower (or right ""))))

(defn- matrix-variant-name
  [token-set]
  (ctob/join-set-path (rest (ctob/get-set-path token-set))))

(defn- matrix-paired-theme
  [tokens-lib domain-name token-set]
  (let [set-name (ctob/get-name token-set)
        variant-name (matrix-variant-name token-set)
        candidates (->> (ctob/get-themes tokens-lib)
                        (remove ctob/hidden-theme?)
                        (filter #(contains? (:sets %) set-name))
                        (filter #(same-matrix-name? (:group %) domain-name)))
        exact (some #(when (and (= (:group %) domain-name)
                                (= (:name %) variant-name))
                       %)
                    candidates)]
    (or exact
        (when (= 1 (count candidates))
          (first candidates)))))

(defn- normalized-active-theme-paths
  [tokens-lib]
  (let [active-theme-paths (spts/get-active-theme-paths tokens-lib)]
    (if (= active-theme-paths #{ctob/hidden-theme-path})
      active-theme-paths
      (disj active-theme-paths ctob/hidden-theme-path))))

(defn- update-theme-in-lib
  [tokens-lib theme]
  (ctob/update-theme tokens-lib (ctob/get-id theme) (constantly theme)))

(defn- replace-theme-set-names
  [theme replacements]
  (update theme :sets
          (fn [set-names]
            (into #{} (map #(get replacements % %)) set-names))))

(defn- theme-path-after-update
  [active-theme-paths old-theme new-theme]
  (let [old-path (ctob/get-theme-path old-theme)
        new-path (ctob/get-theme-path new-theme)]
    (if (and (not= old-path new-path)
             (contains? active-theme-paths old-path))
      (-> active-theme-paths
          (disj old-path)
          (conj new-path))
      active-theme-paths)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Helpers
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

;; TODO HYMA: Copied over from workspace.cljs
(defn update-shape
  [id attrs]
  (assert (uuid? id) "expected valid uuid for `id`")

  (let [attrs (cts/check-shape-attrs attrs)]
    (ptk/reify ::update-shape
      ptk/WatchEvent
      (watch [_ _ _]
        (rx/of (dwsh/update-shapes [id] #(merge % attrs)))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TOKENS TREE - Type folders
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

;; Helper functions for localStorage persistence
(defn- get-unfolded-token-types-from-storage
  [file-id set-id]
  (get-in storage/user [:app.main.ui.workspace.tokens/unfolded-token-types file-id set-id] #{}))

(defn- save-unfolded-token-types-in-storage
  [file-id set-id types]
  (swap! storage/user update :app.main.ui.workspace.tokens/unfolded-token-types
         assoc-in [file-id set-id] (vec types)))

;; Helper functions for app state persistence
(defn- make-unfolded-token-types-state
  [file-id set-id types]
  {:file-id file-id
   :set-id set-id
   :types (set (or types #{}))})

(defn- get-unfolded-token-types-from-state
  [state]
  (let [value (get-in state [:workspace-tokens :unfolded-token-types])]
    (or (:types value) #{})))

(defn restore-unfolded-token-types
  "Loads unfolded token types from localStorage for the current file and set"
  []
  (ptk/reify ::restore-unfolded-token-types
    ptk/UpdateEvent
    (update [_ state]
      (let [file-id (:current-file-id state)
            set-id  (get-in state [:workspace-tokens :selected-token-set-id])
            stored  (get-unfolded-token-types-from-storage file-id set-id)]
        (assoc-in state
                  [:workspace-tokens :unfolded-token-types]
                  (make-unfolded-token-types-state file-id set-id stored))))))

(defn open-token-type
  ([types type]
   (conj (or types #{}) type))
  ([type]
   (ptk/reify ::open-token-type
     ptk/UpdateEvent
     (update [_ state]
       (let [file-id   (:current-file-id state)
             set-id    (get-in state [:workspace-tokens :selected-token-set-id])
             types     (get-unfolded-token-types-from-state state)
             new-types (open-token-type types type)
             new-state (assoc-in state
                                 [:workspace-tokens :unfolded-token-types]
                                 (make-unfolded-token-types-state file-id set-id new-types))]
         (save-unfolded-token-types-in-storage file-id set-id
                                               new-types)
         new-state)))))

(defn close-token-type
  ([types type]
   (disj (or types #{}) type))
  ([type]
   (ptk/reify ::close-token-type
     ptk/UpdateEvent
     (update [_ state]
       (let [file-id   (:current-file-id state)
             set-id    (get-in state [:workspace-tokens :selected-token-set-id])
             types     (get-unfolded-token-types-from-state state)
             new-types (close-token-type types type)
             new-state (assoc-in state
                                 [:workspace-tokens :unfolded-token-types]
                                 (make-unfolded-token-types-state file-id set-id new-types))]
         (save-unfolded-token-types-in-storage file-id set-id
                                               new-types)
         new-state)))))

(defn
  toggle-token-type
  [type]
  (ptk/reify ::toggle-token-type
    ptk/UpdateEvent
    (update [_ state]
      (let [file-id   (:current-file-id state)
            set-id    (get-in state [:workspace-tokens :selected-token-set-id])
            types     (get-unfolded-token-types-from-state state)
            new-types (if (contains? types type)
                        (close-token-type types type)
                        (open-token-type types type))
            new-state (assoc-in state
                                [:workspace-tokens :unfolded-token-types]
                                (make-unfolded-token-types-state file-id set-id new-types))]
        (save-unfolded-token-types-in-storage file-id set-id
                                              new-types)
        new-state))))

(defn clear-tokens-types
  []
  (ptk/reify ::clear-tokens-types
    ptk/UpdateEvent
    (update [_ state]
      (let [file-id (:current-file-id state)
            set-id  (get-in state [:workspace-tokens :selected-token-set-id])]
        (save-unfolded-token-types-in-storage file-id set-id #{})
        (assoc-in state
                  [:workspace-tokens :unfolded-token-types]
                  (make-unfolded-token-types-state file-id set-id #{}))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TOKENS TREE - Toggle tree nodes
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- remove-path
  [path paths]
  (->> paths
       (remove #(= % path))
       vec))

(defn add-path
  [path paths]
  (vec (conj paths path)))

(defn clear-tokens-paths
  []
  (ptk/reify ::clear-tokens-paths
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:workspace-tokens :folded-token-paths] []))))

(defn toggle-token-path
  [path]
  (ptk/reify ::toggle-token-path
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:workspace-tokens :folded-token-paths]
                 (fn [paths]
                   (let [paths (or paths [])]
                     (if (some #(= % path) paths)
                       (remove-path path paths)
                       (add-path path paths))))))))

(defn toggle-nested-token-path
  [token-type new-name]
  (ptk/reify ::toggle-nested-token-path
    ptk/UpdateEvent
    (update [_ state]
      (let [type-str (name token-type)
            segments (str/split new-name ".")
            n-groups (dec (count segments))]
        (if (pos? n-groups)
          (update-in state [:workspace-tokens :folded-token-paths]
                     (fn [paths]
                       (reduce (fn [ps i]
                                 (remove-path (str type-str "." (str/join "." (take i segments))) ps))
                               (or paths [])
                               (range 1 (inc n-groups)))))
          state)))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TOKENS Actions
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn create-token-theme
  [token-theme]
  (let [new-token-theme token-theme]
    (ptk/reify ::create-token-theme
      ptk/WatchEvent
      (watch [it state _]
        (let [data       (dsh/lookup-file-data state)
              tokens-lib (dsh/lookup-tokens-lib state)]
          (if (and tokens-lib (ctob/get-theme tokens-lib (ctob/get-id token-theme)))
            (rx/of (ntf/show {:content (tr "errors.token-theme-already-exists")
                              :type :toast
                              :level :error
                              :timeout 9000}))
            (let [changes (-> (pcb/empty-changes it)
                              (pcb/with-library-data data)
                              (pcb/set-token-theme (ctob/get-id new-token-theme)
                                                   new-token-theme))]
              (rx/of (dch/commit-changes changes)))))))))

(defn create-token-matrix-domain
  "Creates a top-level Set Group with a real Default Set and paired active Theme."
  [domain-name]
  (assert (string? domain-name) "expected a string for `domain-name`")
  (ptk/reify ::create-token-matrix-domain
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (or (spts/file-library data)
                           (ctob/make-tokens-lib))
            path [domain-name]]
        (when (not (ctob/set-group-path-exists? tokens-lib path))
          (let [set-name (ctob/join-set-path [domain-name "Default"])
                token-set (ctob/make-token-set :name set-name)
                token-theme (ctob/make-token-theme
                             :name "Default"
                             :group domain-name
                             :sets #{set-name})
                tokens-lib' (-> tokens-lib
                                (ctob/add-set token-set)
                                (ctob/add-theme token-theme)
                                (spts/activate-theme (ctob/get-id token-theme)))
                undo-group (uuid/next)
                changes (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/set-token-set (ctob/get-id token-set) token-set)
                            (pcb/set-token-theme (ctob/get-id token-theme) token-theme)
                            (spts/set-active-token-themes
                             (normalized-active-theme-paths tokens-lib'))
                            (pcb/set-undo-group undo-group))]
            (rx/of (set-selected-token-set-id (ctob/get-id token-set))
                   (dch/commit-changes changes)
                   (dwtp/propagate-workspace-tokens undo-group))))))))

(defn duplicate-token-matrix-variant
  "Creates an independent matrix column by copying the first Set once."
  [domain-name source-set-id]
  (assert (string? domain-name) "expected a string for `domain-name`")
  (assert (uuid? source-set-id) "expected a uuid for `source-set-id`")
  (ptk/reify ::duplicate-token-matrix-variant
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            source-set (ctob/get-set tokens-lib source-set-id)]
        (when source-set
          (let [suffix (tr "workspace.tokens.duplicate-suffix")
                source-theme (matrix-paired-theme tokens-lib domain-name source-set)
                variant-names (->> (ctob/get-sets-at-path tokens-lib [domain-name])
                                   (map matrix-variant-name))
                variant-name (cfh/generate-unique-name
                              (matrix-variant-name source-set)
                              variant-names
                              :suffix suffix)
                set-name (ctob/join-set-path [domain-name variant-name])
                token-set (copy-token-set tokens-lib source-set-id set-name)
                dependency-sets (disj (or (:sets source-theme) #{})
                                      (ctob/get-name source-set))
                token-theme (ctob/make-token-theme
                             :name variant-name
                             :group domain-name
                             :description (or (:description source-theme) "")
                             :sets (conj dependency-sets set-name))
                tokens-lib' (-> tokens-lib
                                (ctob/add-set token-set)
                                (ctob/add-theme token-theme)
                                (spts/activate-theme (ctob/get-id token-theme)))
                undo-group (uuid/next)
                changes (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/set-token-set (ctob/get-id token-set) token-set)
                            (pcb/set-token-theme (ctob/get-id token-theme)
                                                 token-theme)
                            (spts/set-active-token-themes
                             (normalized-active-theme-paths tokens-lib'))
                            (pcb/set-undo-group undo-group))]
            (rx/of (set-selected-token-set-id (ctob/get-id token-set))
                   (dch/commit-changes changes)
                   (dwtp/propagate-workspace-tokens undo-group))))))))

(defn activate-token-matrix-variant
  "Activates a variant's paired Theme, creating the pair for an imported Set if needed."
  [domain-name set-id]
  (assert (string? domain-name) "expected a string for `domain-name`")
  (assert (uuid? set-id) "expected a uuid for `set-id`")
  (ptk/reify ::activate-token-matrix-variant
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            token-set (ctob/get-set tokens-lib set-id)]
        (when token-set
          (let [existing-theme (matrix-paired-theme tokens-lib domain-name token-set)
                token-theme (or existing-theme
                                (ctob/make-token-theme
                                 :name (matrix-variant-name token-set)
                                 :group domain-name
                                 :sets #{(ctob/get-name token-set)}))
                tokens-lib' (cond-> tokens-lib
                              (nil? existing-theme) (ctob/add-theme token-theme)
                              true (spts/activate-theme (ctob/get-id token-theme)))
                undo-group (uuid/next)
                changes (cond-> (-> (pcb/empty-changes it)
                                    (pcb/with-library-data data))
                          (nil? existing-theme)
                          (pcb/set-token-theme (ctob/get-id token-theme) token-theme)

                          true
                          (spts/set-active-token-themes
                           (normalized-active-theme-paths tokens-lib'))

                          true
                          (pcb/set-undo-group undo-group))]
            (rx/of (set-selected-token-set-id set-id)
                   (dch/commit-changes changes)
                   (dwtp/propagate-workspace-tokens undo-group))))))))

(defn update-token-theme
  [id token-theme]
  (ptk/reify ::update-token-theme
    ptk/WatchEvent
    (watch [it state _]
      (let [data       (dsh/lookup-file-data state)
            tokens-lib (dsh/lookup-tokens-lib state)]
        (if (and (not= id (ctob/get-id token-theme))
                 (ctob/get-theme tokens-lib (ctob/get-id token-theme)))
          (rx/of (ntf/show {:content (tr "errors.token-theme-already-exists")
                            :type :toast
                            :level :error
                            :timeout 9000}))
          (let [changes (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (clo/generate-update-token-theme token-theme))]
            (rx/of (dch/commit-changes changes))))))))

(defn set-token-theme-active
  [id active?]
  (assert (uuid? id) "expected a uuid for `id`")
  (assert (boolean? active?) "expected a boolean for `active?`")
  (ptk/reify ::set-token-theme-active
    ptk/WatchEvent
    (watch [_ state _]
      (let [data          (dsh/lookup-file-data state)
            tokens-status (dsh/lookup-tokens-status state)
            tokens-lib    (dsh/lookup-tokens-lib state)
            changes       (-> (pcb/empty-changes)
                              (pcb/with-library-data data)
                              (clo/generate-set-theme-status tokens-status tokens-lib id active?))]

        (rx/of (dch/commit-changes changes)
               (dwtp/propagate-workspace-tokens))))))

(defn toggle-token-theme-active
  [id]
  (assert (uuid? id) "expected a uuid for `id`")
  (ptk/reify ::toggle-token-theme-active
    ptk/WatchEvent
    (watch [it state _]
      (let [data          (dsh/lookup-tokens-source-data state)
            tokens-status (dsh/lookup-tokens-status state)
            tokens-lib    (dsh/lookup-tokens-lib state)
            changes       (-> (pcb/empty-changes it)
                              (pcb/with-library-data data)
                              (clo/generate-toggle-theme tokens-status tokens-lib id))]
        (rx/of
         (dch/commit-changes changes)
         (dwtp/propagate-workspace-tokens))))))

(defn delete-token-theme
  [id]
  (assert (uuid? id) "expected a uuid for `id`")
  (ptk/reify ::delete-token-theme
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/set-token-theme id nil))]
        (rx/of
         (dch/commit-changes changes)
         (dwtp/propagate-workspace-tokens))))))

(defn create-token-set
  [token-set]
  (assert (ctob/token-set? token-set) "a token set is required") ;; TODO should check token-set-schema?
  (ptk/reify ::create-token-set
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/set-token-set (ctob/get-id token-set) token-set))]
        (rx/of (set-selected-token-set-id (ctob/get-id token-set))
               (dch/commit-changes changes))))))

(defn rename-token-set
  [token-set new-name]
  (assert (ctob/token-set? token-set) "a token set is required") ;; TODO should check token-set-schema after renaming?
  (assert (string? new-name) "a new name is required") ;; TODO should assert normalized-set-name?
  (ptk/reify ::update-token-set
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/rename-token-set (ctob/get-id token-set) new-name))]
        (rx/of (set-selected-token-set-id (ctob/get-id token-set))
               (dch/commit-changes changes))))))

(defn rename-token-set-group
  [set-group-path set-group-fname]
  (ptk/reify ::rename-token-set-group
    ptk/WatchEvent
    (watch [it _state _]
      (let [changes (-> (pcb/empty-changes it)
                        (pcb/rename-token-set-group set-group-path set-group-fname))]
        (rx/of
         (dch/commit-changes changes))))))

(defn rename-token-matrix-domain
  "Renames a matrix Set Group and keeps Theme groups and Set references aligned."
  [domain-path new-name]
  (assert (vector? domain-path) "expected a vector for `domain-path`")
  (assert (string? new-name) "expected a string for `new-name`")
  (ptk/reify ::rename-token-matrix-domain
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            old-name (last domain-path)
            affected-sets (ctob/get-sets-at-path tokens-lib domain-path)
            replacements
            (into {}
                  (map (fn [token-set]
                         (let [old-set-name (ctob/get-name token-set)
                               new-set-name (-> (ctob/get-set-path token-set)
                                                (assoc (dec (count domain-path)) new-name)
                                                (ctob/join-set-path))]
                           [old-set-name new-set-name])))
                  affected-sets)
            themes (remove ctob/hidden-theme? (ctob/get-themes tokens-lib))
            updated-themes
            (keep (fn [theme]
                    (let [uses-domain? (seq (set/intersection
                                             (set (keys replacements))
                                             (:sets theme)))
                          theme' (cond-> (replace-theme-set-names theme replacements)
                                   (and uses-domain?
                                        (same-matrix-name? (:group theme)
                                                           old-name))
                                   (assoc :group new-name))]
                      (when (not= theme theme') [theme theme'])))
                  themes)
            active-theme-paths
            (reduce (fn [paths [old-theme new-theme]]
                      (theme-path-after-update paths old-theme new-theme))
                    (spts/get-active-theme-paths tokens-lib)
                    updated-themes)
            changes
            (reduce (fn [changes [_ theme]]
                      (pcb/set-token-theme changes (ctob/get-id theme) theme))
                    (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/rename-token-set-group domain-path new-name))
                    updated-themes)
            undo-group (uuid/next)
            changes (-> changes
                        (spts/set-active-token-themes active-theme-paths)
                        (pcb/set-undo-group undo-group))]
        (rx/of (dch/commit-changes changes)
               (dwtp/propagate-workspace-tokens undo-group))))))

(defn rename-token-matrix-variant
  "Renames one matrix Set and its paired Theme while preserving dependencies."
  [domain-name set-id new-name]
  (assert (string? domain-name) "expected a string for `domain-name`")
  (assert (uuid? set-id) "expected a uuid for `set-id`")
  (assert (string? new-name) "expected a string for `new-name`")
  (ptk/reify ::rename-token-matrix-variant
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            token-set (ctob/get-set tokens-lib set-id)]
        (when token-set
          (let [old-set-name (ctob/get-name token-set)
                new-set-name (ctob/normalize-set-name new-name old-set-name)
                paired-theme (matrix-paired-theme tokens-lib domain-name token-set)
                themes (remove ctob/hidden-theme? (ctob/get-themes tokens-lib))
                updated-themes
                (keep (fn [theme]
                        (let [theme' (cond-> (replace-theme-set-names
                                              theme
                                              {old-set-name new-set-name})
                                       (= (ctob/get-id theme)
                                          (some-> paired-theme ctob/get-id))
                                       (assoc :name new-name))]
                          (when (not= theme theme') [theme theme'])))
                      themes)
                active-theme-paths
                (reduce (fn [paths [old-theme new-theme]]
                          (theme-path-after-update paths old-theme new-theme))
                        (spts/get-active-theme-paths tokens-lib)
                        updated-themes)
                changes
                (reduce (fn [changes [_ theme]]
                          (pcb/set-token-theme changes (ctob/get-id theme) theme))
                        (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/rename-token-set set-id new-set-name))
                        updated-themes)
                undo-group (uuid/next)
                changes (-> changes
                            (spts/set-active-token-themes active-theme-paths)
                            (pcb/set-undo-group undo-group))]
            (rx/of (set-selected-token-set-id set-id)
                   (dch/commit-changes changes)
                   (dwtp/propagate-workspace-tokens undo-group))))))))

(defn delete-token-matrix-variant
  "Deletes one matrix Set and its paired Theme, activating the first remaining variant when needed."
  [domain-name set-id]
  (assert (string? domain-name) "expected a string for `domain-name`")
  (assert (uuid? set-id) "expected a uuid for `set-id`")
  (ptk/reify ::delete-token-matrix-variant
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            token-set (ctob/get-set tokens-lib set-id)]
        (when token-set
          (let [set-name (ctob/get-name token-set)
                paired-theme (matrix-paired-theme tokens-lib domain-name token-set)
                paired-theme-id (some-> paired-theme ctob/get-id)
                paired-active? (boolean (and paired-theme-id
                                             (spts/theme-active? tokens-lib paired-theme-id)))
                themes (remove ctob/hidden-theme? (ctob/get-themes tokens-lib))
                theme-actions
                (keep (fn [theme]
                        (cond
                          (= paired-theme-id (ctob/get-id theme))
                          [theme nil]

                          (contains? (:sets theme) set-name)
                          [theme (update theme :sets disj set-name)]

                          :else nil))
                      themes)
                tokens-lib' (reduce (fn [lib [old-theme new-theme]]
                                      (if new-theme
                                        (update-theme-in-lib lib new-theme)
                                        (ctob/delete-theme lib (ctob/get-id old-theme))))
                                    (ctob/delete-set tokens-lib set-id)
                                    theme-actions)
                remaining-set (first (ctob/get-sets-at-path tokens-lib' [domain-name]))
                next-theme (when (and paired-active? remaining-set)
                             (or (matrix-paired-theme tokens-lib' domain-name remaining-set)
                                 (ctob/make-token-theme
                                  :name (matrix-variant-name remaining-set)
                                  :group domain-name
                                  :sets #{(ctob/get-name remaining-set)})))
                add-next-theme? (and next-theme
                                     (nil? (ctob/get-theme tokens-lib'
                                                           (ctob/get-id next-theme))))
                tokens-lib' (cond-> tokens-lib'
                              add-next-theme? (ctob/add-theme next-theme)
                              next-theme (spts/activate-theme (ctob/get-id next-theme)))
                changes
                (reduce (fn [changes [old-theme new-theme]]
                          (pcb/set-token-theme changes
                                               (ctob/get-id old-theme)
                                               new-theme))
                        (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/set-token-set set-id nil))
                        theme-actions)
                changes (cond-> changes
                          add-next-theme?
                          (pcb/set-token-theme (ctob/get-id next-theme) next-theme)

                          true
                          (spts/set-active-token-themes
                           (normalized-active-theme-paths tokens-lib')))
                undo-group (uuid/next)
                changes (pcb/set-undo-group changes undo-group)]
            (if remaining-set
              (rx/of (set-selected-token-set-id (ctob/get-id remaining-set))
                     (dch/commit-changes changes)
                     (dwtp/propagate-workspace-tokens undo-group))
              (rx/of (dch/commit-changes changes)
                     (dwtp/propagate-workspace-tokens undo-group)))))))))

(defn delete-token-matrix-domain
  "Deletes a matrix Set Group and its paired Theme group as one operation."
  [domain-path]
  (assert (vector? domain-path) "expected a vector for `domain-path`")
  (ptk/reify ::delete-token-matrix-domain
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            domain-name (last domain-path)
            token-sets (vec (ctob/get-sets-at-path tokens-lib domain-path))
            set-names (into #{} (map ctob/get-name) token-sets)
            themes (remove ctob/hidden-theme? (ctob/get-themes tokens-lib))
            theme-actions
            (keep (fn [theme]
                    (let [used-domain-sets (set/intersection set-names
                                                             (:sets theme))]
                      (cond
                        (empty? used-domain-sets)
                        nil

                        (and (same-matrix-name? (:group theme) domain-name)
                             (set/subset? (:sets theme) set-names))
                        [theme nil]

                        :else
                        [theme (update theme :sets set/difference set-names)])))
                  themes)
            tokens-lib' (reduce #(ctob/delete-set %1 (ctob/get-id %2))
                                tokens-lib
                                token-sets)
            tokens-lib' (reduce (fn [lib [old-theme new-theme]]
                                  (if new-theme
                                    (update-theme-in-lib lib new-theme)
                                    (ctob/delete-theme lib (ctob/get-id old-theme))))
                                tokens-lib'
                                theme-actions)
            changes (reduce (fn [changes token-set]
                              (pcb/set-token-set changes (ctob/get-id token-set) nil))
                            (-> (pcb/empty-changes it)
                                (pcb/with-library-data data))
                            token-sets)
            changes (reduce (fn [changes [old-theme new-theme]]
                              (pcb/set-token-theme changes
                                                   (ctob/get-id old-theme)
                                                   new-theme))
                            changes
                            theme-actions)
            changes (spts/set-active-token-themes
                     changes
                     (normalized-active-theme-paths tokens-lib'))
            undo-group (uuid/next)
            changes (pcb/set-undo-group changes undo-group)]
        (when (seq token-sets)
          (rx/of (dch/commit-changes changes)
                 (dwtp/propagate-workspace-tokens undo-group)))))))

(defn duplicate-token-set
  ([id]
   (duplicate-token-set id nil))
  ([id {:keys [id-ref]}]
   (ptk/reify ::duplicate-token-set
     ptk/WatchEvent
     (watch [it state _]
       (let [data       (dsh/lookup-file-data state)
             tokens-lib (dsh/lookup-tokens-lib state)
             suffix     (tr "workspace.tokens.duplicate-suffix")]

         (when-let [token-set (when tokens-lib
                                (ctob/duplicate-set id tokens-lib {:suffix suffix}))]
           (when id-ref (reset! id-ref (ctob/get-id token-set)))
           (let [changes (-> (pcb/empty-changes it)
                             (pcb/with-library-data data)
                             (pcb/set-token-set (ctob/get-id token-set) token-set))]
             (rx/of (set-selected-token-set-id (ctob/get-id token-set))
                    (dch/commit-changes changes)))))))))

(defn set-enabled-token-set
  [id enabled?]
  (assert (uuid? id) "expected a uuid for `id`")
  (assert (boolean? enabled?) "expected a boolean for `enabled?`")
  (ptk/reify ::set-enabled-token-set
    ptk/WatchEvent
    (watch [_ state _]
      (let [data          (dsh/lookup-file-data state)
            tokens-lib    (dsh/lookup-tokens-lib state)
            tokens-status (dsh/lookup-tokens-status state)
            changes       (-> (pcb/empty-changes)
                              (pcb/with-library-data data)
                              (clo/generate-set-enabled-token-set tokens-status tokens-lib id enabled?))]

        (rx/of (dch/commit-changes changes)
               (dwtp/propagate-workspace-tokens))))))

(defn toggle-token-set
  [id]
  (assert (uuid? id) "expected a uuid for `id`")
  (ptk/reify ::toggle-token-set
    ptk/WatchEvent
    (watch [_ state _]
      (let [data          (dsh/lookup-file-data state)
            tokens-lib    (dsh/lookup-tokens-lib state)
            tokens-status (dsh/lookup-tokens-status state)
            changes       (-> (pcb/empty-changes)
                              (pcb/with-library-data data)
                              (clo/generate-toggle-token-set tokens-status tokens-lib id))]

        (rx/of
         (dch/commit-changes changes)
         (dwtp/propagate-workspace-tokens))))))

(defn toggle-token-set-group
  [group-path]
  (ptk/reify ::toggle-token-set-group
    ptk/WatchEvent
    (watch [_ state _]
      (let [data          (dsh/lookup-file-data state)
            tokens-lib    (dsh/lookup-tokens-lib state)
            tokens-status (dsh/lookup-tokens-status state)
            changes       (-> (pcb/empty-changes)
                              (pcb/with-library-data data)
                              (clo/generate-toggle-token-set-group tokens-status tokens-lib group-path))]

        (rx/of
         (dch/commit-changes changes)
         (dwtp/propagate-workspace-tokens))))))

(defn import-tokens-lib
  [lib]
  (ptk/reify ::import-tokens-lib
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            status  (cfo/make-tokens-status-from-lib lib)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/set-tokens-lib lib)
                        (pcb/set-tokens-status status))]
        (rx/of (dch/commit-changes changes)
               (dwtp/propagate-workspace-tokens))))))

(defn set-tokens-source
  [library-id]
  (ptk/reify ::set-tokens-source
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            library (dsh/lookup-file state library-id)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (clo/generate-set-tokens-source library)
                        (pcb/set-tokens-source library-id))]
        (rx/of (dch/commit-changes changes))))))

(defn delete-token-set
  [id]
  (ptk/reify ::delete-token-set
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/set-token-set id nil))]
        (rx/of (dch/commit-changes changes)
               (dwtp/propagate-workspace-tokens))))))

(defn delete-token-set-group
  [path]
  (ptk/reify ::delete-token-set-group
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            changes (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (clo/generate-delete-token-set-group (dsh/lookup-tokens-lib state) path))]
        (rx/of (dch/commit-changes changes)
               (dwtp/propagate-workspace-tokens))))))

(defn drop-error
  [{:keys [error to-path]}]
  (ptk/reify ::drop-error
    ptk/WatchEvent
    (watch [_ _ _]
      (let [content (case error
                      :path-exists (tr "errors.token-set-exists-on-drop" to-path)
                      :parent-to-child (tr "errors.drop-token-set-parent-to-child")
                      nil)]
        (when content
          (rx/of
           (ntf/show {:content content
                      :type :toast
                      :level :error
                      :timeout 9000})))))))

;; FIXME: add schema for params

(defn drop-token-set-group
  [drop-opts]
  (ptk/reify ::drop-token-set-group
    ptk/WatchEvent
    (watch [it state _]
      (try
        (when-let [changes (clo/generate-move-token-set-group (pcb/empty-changes it) (dsh/lookup-tokens-lib state) drop-opts)]
          (rx/of
           (dch/commit-changes changes)
           (dwtp/propagate-workspace-tokens)))
        (catch :default e
          (rx/of
           (drop-error (ex-data e))))))))

;; FIXME: add schema for params

(defn drop-token-set
  [params]
  (ptk/reify ::drop-token-set
    ptk/WatchEvent
    (watch [it state _]
      (try
        (let [tokens-lib (dsh/lookup-tokens-lib state)
              changes    (-> (pcb/empty-changes it)
                             (clo/generate-move-token-set tokens-lib params))]
          (rx/of (dch/commit-changes changes)
                 (dwtp/propagate-workspace-tokens)))
        (catch :default cause
          (rx/of (drop-error (ex-data cause))))))))

(defn- create-token-with-set
  "A special case when a first token is created and no set exists"
  [token]
  (ptk/reify ::create-token-and-set
    ptk/WatchEvent
    (watch [_ state _]
      (let [data
            (dsh/lookup-file-data state)

            set-name
            "Global"

            token-set
            (ctob/make-token-set :name set-name)

            hidden-theme                     ;; For legacy compatibility only
            (-> (ctob/make-hidden-theme)
                (ctob/enable-set set-name))

            token-status
            (ctos/make-tokens-status :active-theme-ids #{}
                                     :active-set-ids #{(ctob/get-id token-set)})

            changes
            (-> (pcb/empty-changes)
                (pcb/with-library-data data)
                (pcb/set-token-set (ctob/get-id token-set) token-set)
                (pcb/set-token (ctob/get-id token-set) (:id token) token)
                (pcb/set-token-theme (ctob/get-id hidden-theme)
                                     hidden-theme)
                (pcb/set-tokens-status token-status))]

        (rx/of (dch/commit-changes changes)
               (set-selected-token-set-id (ctob/get-id token-set)))))))

(defn create-token
  ([token] (create-token nil token))
  ([set-id token & {:keys [undo-group]}]
   (ptk/reify ::create-token
     ptk/WatchEvent
     (watch [it state _]
       (if-let [token-set (if set-id
                            (lookup-token-set state set-id)
                            (lookup-token-set state))]
         (let [data    (dsh/lookup-file-data state)
               token-type (:type token)
               changes (-> (pcb/empty-changes it)
                           (pcb/with-library-data data)
                           (pcb/set-token (ctob/get-id token-set)
                                          (:id token)
                                          token)
                           (pcb/set-undo-group undo-group))]

           (rx/of (dch/commit-changes changes)
                  (ev/event (-> {::ev/name "create-token" :type token-type}
                                (merge (meta it))))))

         (rx/of (create-token-with-set token)))))))

(defn create-token-in-sets
  "Creates independent copies of a Token in each Set in one commit."
  [set-ids token & {:keys [undo-group]}]
  (assert (every? uuid? set-ids) "expected uuids in `set-ids`")
  (ptk/reify ::create-token-in-sets
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            set-ids (->> set-ids
                         distinct
                         (filter #(some? (ctob/get-set tokens-lib %))))
            changes
            (reduce
             (fn [changes set-id]
               (let [token' (-> (into {} token)
                                (dissoc :id :modified-at)
                                (ctob/make-token))]
                 (pcb/set-token changes set-id (:id token') token')))
             (-> (pcb/empty-changes it)
                 (pcb/with-library-data data)
                 (pcb/set-undo-group undo-group))
             set-ids)]
        (when (seq set-ids)
          (rx/of (dch/commit-changes changes)
                 (ev/event (-> {::ev/name "create-token"
                                :type (:type token)}
                               (merge (meta it))))))))))

(defn update-token-matrix-row
  "Updates every definition of a matrix row, including renamed references, in one commit."
  [definitions params]
  (assert (sequential? definitions) "expected matrix token definitions")
  (assert (map? params) "expected token params")
  (ptk/reify ::update-token-matrix-row
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            definitions
            (keep (fn [{:keys [set-id token]}]
                    (when-let [current-token
                               (ctob/get-token tokens-lib
                                               set-id
                                               (ctob/get-id token))]
                      {:set-id set-id
                       :token current-token}))
                  definitions)]
        (when (seq definitions)
          (let [old-name (-> definitions first :token :name)
                new-name (or (:name params) old-name)
                token-type (-> definitions first :token :type)
                token-changes
                (reduce (fn [changes {:keys [set-id token]}]
                          (let [token' (->> (merge token params)
                                            (into {})
                                            (ctob/make-token))]
                            (pcb/set-token changes set-id (:id token) token')))
                        (-> (pcb/empty-changes it)
                            (pcb/with-library-data data))
                        definitions)
                changes
                (if (= old-name new-name)
                  token-changes
                  (let [updated-data (cpc/process-changes
                                      data
                                      (:redo-changes token-changes)
                                      false)
                        remap-changes (remap/build-remap-changes
                                       updated-data
                                       old-name
                                       new-name)]
                    (pcb/concat-changes token-changes remap-changes)))
                undo-group (uuid/next)
                changes (pcb/set-undo-group changes undo-group)]
            (rx/of (dch/commit-changes changes)
                   (ev/event (-> {::ev/name "edit-token"
                                  :type token-type}
                                 (merge (meta it))))
                   (dwtp/propagate-workspace-tokens undo-group))))))))

(defn delete-token-matrix-row
  "Deletes every definition of a matrix row in one commit."
  [definitions]
  (assert (sequential? definitions) "expected matrix token definitions")
  (ptk/reify ::delete-token-matrix-row
    ptk/WatchEvent
    (watch [it state _]
      (let [data (dsh/lookup-file-data state)
            tokens-lib (spts/file-library data)
            definitions
            (keep (fn [{:keys [set-id token]}]
                    (when-let [current-token
                               (ctob/get-token tokens-lib
                                               set-id
                                               (ctob/get-id token))]
                      {:set-id set-id
                       :token current-token}))
                  definitions)]
        (when (seq definitions)
          (let [token-type (-> definitions first :token :type)
                undo-group (uuid/next)
                changes
                (reduce (fn [changes {:keys [set-id token]}]
                          (pcb/set-token changes set-id (:id token) nil))
                        (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/set-undo-group undo-group))
                        definitions)]
            (rx/of (dch/commit-changes changes)
                   (ev/event (-> {::ev/name "delete-token"
                                  :type token-type}
                                 (merge (meta it))))
                   (dwtp/propagate-workspace-tokens undo-group))))))))

(defn bulk-create-tokens
  [set-id token-ids type node new-node-name]
  (assert (uuid? set-id) "expected uuid for `set-id`")
  (assert (every? uuid? token-ids) "expected a collection of uuids for `token-ids`")
  (assert (keyword? type) "expected keyword for `type`")
  (assert (string? new-node-name) "expected string for `new-node-name`")

  (ptk/reify ::bulk-create-tokens
    ptk/WatchEvent
    (watch [it state _]
      (let [token-set (lookup-token-set state set-id)
            data    (dsh/lookup-file-data state)
            changes (reduce (fn [changes token-id]
                              (let [token     (-> (dsh/lookup-tokens-lib state)
                                                  (ctob/get-token (ctob/get-id token-set) token-id))
                                    new-name (->
                                              (cpn/split-path (:name token) :separator ".")
                                              (assoc (:depth node) new-node-name)
                                              (cpn/join-path :separator "." :with-spaces? false))
                                    token'    (->> (merge token {:name new-name
                                                                 :id (cthi/new-id! (:name new-name))})
                                                   (into {})
                                                   (ctob/make-token))]
                                (pcb/set-token changes (ctob/get-id token-set) (:id token') token')))
                            (-> (pcb/empty-changes it)
                                (pcb/with-library-data data))
                            token-ids)]
        (rx/of
         (dch/commit-changes changes)
         (ptk/data-event ::ev/event {::ev/name "bulk-create-tokens" :type type}))))))

(defn update-token
  ([id params] (update-token nil id params))
  ([set-id id params & {:keys [undo-group]}]
   (assert (uuid? id) "expected uuid for `id`")

   (ptk/reify ::update-token
     ptk/WatchEvent
     (watch [it state _]
       (let [token-set (if set-id
                         (lookup-token-set state set-id)
                         (lookup-token-set state))
             data      (dsh/lookup-file-data state)
             tokens-lib (dsh/lookup-tokens-lib state)]
         (when (and tokens-lib token-set)
           (let [token     (ctob/get-token tokens-lib (ctob/get-id token-set) id)
                 token'    (->> (merge token params)
                                (into {})
                                (ctob/make-token))
                 token-type (:type token)
                 changes   (-> (pcb/empty-changes it)
                               (pcb/with-library-data data)
                               (pcb/set-token (ctob/get-id token-set)
                                              id
                                              token')
                               (pcb/set-undo-group undo-group))]
             (toggle-token-path (str (name token-type) "." (:name token)))
             (rx/of (dch/commit-changes changes)
                    (ev/event (-> {::ev/name "edit-token" :type token-type}
                                  (merge (meta it))))))))))))

(defn bulk-update-tokens
  [set-id token-ids type old-path new-path & {:keys [undo-group]}]
  (dm/assert! (uuid? set-id))
  (dm/assert! (every? uuid? token-ids))
  (ptk/reify ::bulk-update-tokens
    ptk/WatchEvent
    (watch [it state _]
      (let [token-set (if set-id
                        (lookup-token-set state set-id)
                        (lookup-token-set state))
            data    (dsh/lookup-file-data state)
            changes (reduce (fn [changes token-id]
                              (let [token     (-> (dsh/lookup-tokens-lib state)
                                                  (ctob/get-token (ctob/get-id token-set) token-id))
                                    new-name (str/replace (:name token) old-path new-path)
                                    token'    (->> (merge token {:name new-name})
                                                   (into {})
                                                   (ctob/make-token))]
                                (pcb/set-token changes (ctob/get-id token-set) token-id token')))
                            (-> (pcb/empty-changes it)
                                (pcb/with-library-data data))

                            token-ids)

            changes (cond-> changes (some? undo-group) (assoc :undo-group undo-group))]
        (toggle-token-path (str (name type) "." old-path))
        (toggle-token-path (str (name type) "." new-path))
        (rx/of (dch/commit-changes changes)
               (ptk/data-event ::ev/event {::ev/name "bulk-update-tokens" :type type}))))))

(defn delete-token
  [set-id token-id & {:keys [undo-group]}]
  (dm/assert! (uuid? set-id))
  (dm/assert! (uuid? token-id))
  (ptk/reify ::delete-token
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            tokens-lib (dsh/lookup-tokens-lib state)
            token-set (if set-id
                        (lookup-token-set state set-id)
                        (lookup-token-set state))]
        (when (and tokens-lib token-set)
          (let [token     (ctob/get-token tokens-lib (ctob/get-id token-set) token-id)
                token-type (:type token)

                changes (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/set-token set-id token-id nil)
                            (pcb/set-undo-group undo-group))]
            (rx/of (dch/commit-changes changes)
                   (ev/event (-> {::ev/name "delete-token" :type token-type}
                                 (merge (meta it)))))))))))

(defn bulk-delete-tokens
  [set-id token-ids]
  (dm/assert! (uuid? set-id))
  (dm/assert! (every? uuid? token-ids))
  (ptk/reify ::bulk-delete-tokens
    ptk/WatchEvent
    (watch [it state _]
      (let [data    (dsh/lookup-file-data state)
            changes (reduce (fn [changes token-id]
                              (pcb/set-token changes set-id token-id nil))
                            (-> (pcb/empty-changes it)
                                (pcb/with-library-data data))
                            token-ids)]
        (rx/of (dch/commit-changes changes)
               (ev/event {::ev/name "delete-token-node"}))))))

(defn duplicate-token
  [token-id]
  (dm/assert! (uuid? token-id))
  (ptk/reify ::duplicate-token
    ptk/WatchEvent
    (watch [_ state _]
      (when-let [token-set (lookup-token-set state)]
        (when-let [tokens-lib (dsh/lookup-tokens-lib state)]
          (when-let [token (ctob/get-token tokens-lib
                                           (ctob/get-id token-set)
                                           token-id)]
            (let [tokens (vals (ctob/get-tokens tokens-lib (ctob/get-id token-set)))
                  unames (map :name tokens)     ;; TODO: add function duplicate-token in tokens-lib
                  ;; "copy" is intentionally not translated here. Token names are validated
                  ;; against a restricted set of allowed characters (currently English-compatible),
                  ;; so translating this suffix could introduce invalid characters and break
                  ;; token name validation.
                  suffix "copy"
                  copy-name (cfh/generate-unique-name (:name token) unames :suffix suffix)
                  new-token (-> token
                                (ctob/reid (uuid/next))
                                (ctob/rename copy-name))]
              (rx/of (create-token new-token)))))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TOKEN UI OPS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;



(defn assign-token-context-menu
  [{:keys [position] :as params}]

  (when params
    (assert (gpt/point? position) "expected a point instance for `position` param"))

  (ptk/reify ::show-token-context-menu
    ptk/UpdateEvent
    (update [_ state]
      (if params
        (update state :workspace-tokens assoc :token-context-menu params)
        (update state :workspace-tokens dissoc :token-context-menu)))))

(defn assign-token-node-context-menu
  [{:keys [position] :as params}]

  (when params
    (assert (gpt/point? position) "expected a point instance for `position` param"))

  (ptk/reify ::show-token-node-context-menu
    ptk/UpdateEvent
    (update [_ state]
      (if params
        (update state :workspace-tokens assoc :token-node-context-menu params)
        (update state :workspace-tokens dissoc :token-node-context-menu)))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TOKEN-SET UI OPS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn assign-token-set-context-menu
  [{:keys [position] :as params}]
  (when params
    (assert (gpt/point? position) "expected valid point for `position` param"))

  (ptk/reify ::assign-token-set-context-menu
    ptk/UpdateEvent
    (update [_ state]
      (if params
        (update state :workspace-tokens assoc :token-set-context-menu params)
        (update state :workspace-tokens dissoc :token-set-context-menu)))))

(defn set-selected-token-set-id
  [id]
  (ptk/reify ::set-selected-token-set-id
    ptk/UpdateEvent
    (update [_ state]
      (let [file-id (:current-file-id state)
            stored  (get-unfolded-token-types-from-storage file-id id)]
        (-> state
            (update :workspace-tokens assoc :selected-token-set-id id)
            (assoc-in [:workspace-tokens :unfolded-token-types]
                      (make-unfolded-token-types-state file-id id stored)))))))

(defn start-token-set-edition
  [edition-id]
  ;; Path string for edition of a group, UUID for edition of a set.
  (assert (or (string? edition-id) (uuid? edition-id)) "expected a string or uuid for `edition-id`")

  (ptk/reify ::start-token-set-edition
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-tokens assoc :token-set-edition-id edition-id))))

(defn start-token-set-creation
  [path]
  (assert (vector? path) "expected a vector for `path`")

  (ptk/reify ::start-token-set-creation
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-tokens assoc :token-set-new-path path))))

(defn clear-token-set-edition
  []
  (ptk/reify ::clear-token-set-edition
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-tokens dissoc :token-set-edition-id))))

(defn clear-token-set-creation
  []
  (ptk/reify ::clear-token-set-creation
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-tokens dissoc :token-set-new-path))))
