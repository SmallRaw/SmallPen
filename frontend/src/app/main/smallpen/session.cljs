;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.session
  (:require
   [app.common.features :as features]
   [app.common.uuid :as uuid]))

(def ^:private local-profile-id
  #uuid "5a0011e7-1dca-4d5a-8e9e-b2f9ec407899")

(def local-team-id
  #uuid "00000000-0000-4000-8000-000000000001")

(def local-project-id
  #uuid "00000000-0000-4000-8000-000000000002")

(defn home-snapshot
  "Build the application-level session used before a Package is selected."
  [preferences]
  {:entries {}
   :manifest {:entries {:assets []}}
   :preferences preferences
   :runtime {:project (str local-project-id)}})

(defn- owner-permissions
  [snapshot]
  {:type :membership
   :is-owner true
   :is-admin true
   :can-edit (not (true? (get-in snapshot [:packageStatus :readOnly])))
   :can-read true
   :is-logged true})

(defn- lookup
  [data key]
  (or (get data key)
      (when (string? key)
        (get data (keyword key)))))

(defn- runtime-id
  [snapshot kind & stable-path]
  (-> (reduce lookup (get-in snapshot [:runtime kind]) stable-path)
      (uuid/parse)))

(defn- asset-library
  [snapshot]
  (some->> (first (get-in snapshot [:manifest :entries :assets]))
           (lookup (:entries snapshot))))

(defn font-variants
  [snapshot]
  (let [team-id local-team-id]
    (->> (:fonts (asset-library snapshot))
         (mapcat
          (fn [{font-id :id :keys [family variants]}]
            (map
             (fn [{variant-id :id :keys [files name style weight]}]
               (cond-> {:id (runtime-id snapshot :fontVariants variant-id)
                        :team-id team-id
                        :font-id (runtime-id snapshot :fonts font-id)
                        :font-family family
                        :font-weight weight
                        :font-style style
                        :variant-name name
                        :woff1-file-id
                        (runtime-id snapshot :fontFiles variant-id "woff")}
                 (:woff2 files)
                 (assoc :woff2-file-id
                        (runtime-id snapshot :fontFiles variant-id "woff2"))
                 (:ttf files)
                 (assoc :ttf-file-id
                        (runtime-id snapshot :fontFiles variant-id "ttf"))
                 (:otf files)
                 (assoc :otf-file-id
                        (runtime-id snapshot :fontFiles variant-id "otf"))))
             variants)))
         (vec))))

(defn profile
  [snapshot]
  (let [{:keys [language renderer theme]} (:preferences snapshot)]
    {:id local-profile-id
     :email "local@smallpen.invalid"
     :fullname "SmallPen Local"
     :lang (or language "")
     :theme (or theme "dark")
     :auth-backend "smallpen"
     :default-project-id (runtime-id snapshot :project)
     :default-team-id local-team-id
     :is-active true
     :is-blocked false
     :is-demo false
     :is-muted false
     :props {:onboarding-viewed true
             :renderer (or (some-> renderer keyword) :svg)
             :v2-info-shown true
             :workspace-visited true}}))

(defn team
  [snapshot]
  {:id local-team-id
   :name "SmallPen Local"
   :features features/default-features
   :is-default true
   :permissions (owner-permissions snapshot)})

(defn project
  [snapshot]
  {:id (runtime-id snapshot :project)
   :team-id local-team-id
   :name "SmallPen Local Package"
   :count 1
   :is-default true})

(defn member
  [snapshot]
  (assoc (profile snapshot)
         :role :owner
         :permissions (owner-permissions snapshot)))

(defn viewer-bundle
  "Build the complete local response consumed by Penpot's prototype viewer."
  [snapshot file]
  (let [team        (team snapshot)
        member      (member snapshot)
        permissions (:permissions team)]
    {:users [member]
     :profiles [member]
     :fonts (font-variants snapshot)
     :project (project snapshot)
     :share-links []
     :libraries []
     :file file
     :team team
     :permissions permissions
     :thumbnails {}}))

(defn default-page-id
  [snapshot]
  (let [manifest        (:manifest snapshot)
        screen-id       (:defaultScreenId manifest)
        screen-entry    (->> (get-in manifest [:entries :screens])
                             (map #(lookup (:entries snapshot) %))
                             (some #(when (= (:id %) screen-id) %)))
        presentation-id (:basePresentationId screen-entry)]
    (-> snapshot
        (get-in [:runtime :pages])
        (lookup screen-id)
        (lookup presentation-id)
        (uuid/parse))))
