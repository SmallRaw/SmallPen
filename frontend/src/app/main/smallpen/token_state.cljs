;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.token-state
  "Boundary between SmallPen's path-based theme selection and TokensStatus.
  Library views here are temporary; writes always use the native status change."
  (:require
   [app.common.files.changes-builder :as pcb]
   [app.common.files.tokens :as cfo]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [clojure.datafy :refer [datafy]]))

(defn get-active-theme-paths [lib]
  (or (ctob/get-legacy-active-themes lib) #{}))

(defn set-active-themes [lib paths]
  (let [{:keys [sets themes]} (datafy lib)]
    (ctob/make-tokens-lib :sets sets :themes themes :active-themes (set paths))))

(defn theme-active? [lib id]
  (contains? (get-active-theme-paths lib)
             (some-> (ctob/get-theme lib id) ctob/get-theme-path)))

(defn activate-theme [lib id]
  (let [theme (ctob/get-theme lib id)
        same-group (into #{} (comp (filter #(= (:group %) (:group theme)))
                                   (map ctob/get-theme-path))
                         (ctob/get-themes lib))]
    (set-active-themes lib
                       (conj (into #{} (remove same-group)
                                   (disj (get-active-theme-paths lib) ctob/hidden-theme-path))
                             (ctob/get-theme-path theme)))))

(defn get-active-themes-set-names [lib]
  (into #{} (comp (filter #(theme-active? lib (ctob/get-id %))) (mapcat :sets))
        (ctob/get-themes lib)))

(defn get-tokens-in-active-sets [lib]
  (cfo/get-tokens-in-active-sets (cfo/make-tokens-status-from-lib lib) lib))

(defn library-with-status [lib status]
  (if (and lib status)
    (let [set-ids (ctos/get-active-set-ids status)
          theme-ids (ctos/get-active-theme-ids status)
          names (into #{} (comp (filter #(contains? set-ids (ctob/get-id %)))
                                (map ctob/get-name)) (ctob/get-sets lib))
          paths (into #{} (comp (filter #(contains? theme-ids (ctob/get-id %)))
                                (map ctob/get-theme-path)) (ctob/get-themes lib))]
      (-> lib
          (ctob/update-theme ctob/hidden-theme-id #(assoc % :sets names))
          (set-active-themes (conj paths ctob/hidden-theme-path))))
    lib))

(defn file-library [data]
  (library-with-status (:tokens-lib data) (:tokens-status data)))

(defn set-active-token-themes [changes paths]
  (let [lib (:tokens-lib (::pcb/library-data (meta changes)))
        status (cfo/make-tokens-status-from-lib (set-active-themes lib paths))]
    (pcb/set-tokens-status changes status)))
