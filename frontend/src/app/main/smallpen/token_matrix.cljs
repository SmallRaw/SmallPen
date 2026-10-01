;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.token-matrix
  "SmallPen token matrix events: a top-level Set Group is a domain, each Set
  in it is a variant paired with a Theme of the same group. Every event is a
  single undoable commit followed by token propagation."
  (:require
   [app.common.files.changes :as cpc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.event :as ev]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.tokens.library-edit :as dwtl]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.data.workspace.tokens.remapping :as remap]
   [app.main.smallpen.token-state :as spts]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [clojure.set :as set]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

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

(defn- update-theme-in-lib
  [tokens-lib theme]
  (ctob/update-theme tokens-lib (ctob/get-id theme) (constantly theme)))

(defn- replace-theme-set-names
  [theme replacements]
  (update theme :sets
          (fn [set-names]
            (into #{} (map #(get replacements % %)) set-names))))

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
                             tokens-lib'
                             (spts/get-active-theme-paths tokens-lib'))
                            (pcb/set-undo-group undo-group))]
            (rx/of (dwtl/set-selected-token-set-id (ctob/get-id token-set))
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
                             tokens-lib'
                             (spts/get-active-theme-paths tokens-lib'))
                            (pcb/set-undo-group undo-group))]
            (rx/of (dwtl/set-selected-token-set-id (ctob/get-id token-set))
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
                           tokens-lib'
                           (spts/get-active-theme-paths tokens-lib'))

                          true
                          (pcb/set-undo-group undo-group))]
            (rx/of (dwtl/set-selected-token-set-id set-id)
                   (dch/commit-changes changes)
                   (dwtp/propagate-workspace-tokens undo-group))))))))

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
            changes
            (reduce (fn [changes [_ theme]]
                      (pcb/set-token-theme changes (ctob/get-id theme) theme))
                    (-> (pcb/empty-changes it)
                        (pcb/with-library-data data)
                        (pcb/rename-token-set-group domain-path new-name))
                    updated-themes)
            undo-group (uuid/next)
            ;; Renames keep Set and Theme ids, so the TokensStatus is unchanged.
            changes (pcb/set-undo-group changes undo-group)]
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
                changes
                (reduce (fn [changes [_ theme]]
                          (pcb/set-token-theme changes (ctob/get-id theme) theme))
                        (-> (pcb/empty-changes it)
                            (pcb/with-library-data data)
                            (pcb/rename-token-set set-id new-set-name))
                        updated-themes)
                undo-group (uuid/next)
                ;; Renames keep Set and Theme ids, so the TokensStatus is unchanged.
                changes (pcb/set-undo-group changes undo-group)]
            (rx/of (dwtl/set-selected-token-set-id set-id)
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
                           tokens-lib'
                           (spts/get-active-theme-paths tokens-lib')))
                undo-group (uuid/next)
                changes (pcb/set-undo-group changes undo-group)]
            (if remaining-set
              (rx/of (dwtl/set-selected-token-set-id (ctob/get-id remaining-set))
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
                     tokens-lib'
                     (spts/get-active-theme-paths tokens-lib'))
            undo-group (uuid/next)
            changes (pcb/set-undo-group changes undo-group)]
        (when (seq token-sets)
          (rx/of (dch/commit-changes changes)
                 (dwtp/propagate-workspace-tokens undo-group)))))))

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
