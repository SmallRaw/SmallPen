;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.tokens.logic.token-data-test
  (:require
   [app.common.files.tokens :as cfo]
   [app.main.smallpen.token-state :as spts]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.tokens :as ctho]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.tokens.library-edit :as dwtl]
   [app.main.data.workspace.undo :as dwu]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.pages :as thp]
   [frontend-tests.helpers.state :as ths]
   [frontend-tests.tokens.helpers.state :as tohs]
   [frontend-tests.tokens.helpers.tokens :as toht]))

(defn- activate-file-theme [file id]
  (update file :data
          (fn [data]
            (assoc data :tokens-status
                   (cfo/activate-theme (:tokens-status data) (:tokens-lib data) id)))))

(defn- current-tokens-library [file]
  (spts/file-library (:data file)))

(t/use-fixtures :each
  {:before thp/reset-idmap!})

(defn setup-file []
  (cthf/sample-file :file-1 :page-label :page-1))

(defn setup-file-with-token-lib
  []
  (ctho/sample-file-with-tokens
   :file-id :file-1
   :page-label :page-1
   :lib-fn #(ctob/add-set % (ctob/make-token-set :id (cthi/new-id! :test-token-set)
                                                 :name "Set A"))
   :status-fn #(ctos/set-tokens-status % #{} #{(cthi/id :test-token-set)})))

(defn setup-file-with-token-lib-and-theme
  [theme-id]
  (ctho/sample-file-with-tokens
   :file-id :file-1
   :page-label :page-1
   :lib-fn #(-> %
                (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :test-token-set)
                                                   :name "Set A"))
                (ctob/add-theme (ctob/make-token-theme :id theme-id
                                                       :name "Theme A"
                                                       :group "default")))
   :status-fn #(ctos/set-tokens-status % #{theme-id} #{(cthi/id :test-token-set)})))

(defn setup-file-with-token-lib-and-token
  []
  (ctho/sample-file-with-tokens
   :file-id :file-1
   :page-label :page-1
   :lib-fn #(-> %
                (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :test-token-set)
                                                   :name "Set A"))
                (ctob/add-token (cthi/id :test-token-set)
                                (ctob/make-token :id (cthi/new-id! :color.primary)
                                                 :name "color.primary"
                                                 :type :color
                                                 :value "#000000")))
   :status-fn #(ctos/set-tokens-status % #{} #{(cthi/id :test-token-set)})))

(defn setup-file-with-matrix-token-lib-legacy
  []
  (-> (setup-file)
      (assoc-in [:data :tokens-lib]
                (-> (ctob/make-tokens-lib)
                    (ctob/add-set
                     (ctob/make-token-set
                      :id (cthi/new-id! :mobile-set)
                      :name "Device/Mobile"
                      :tokens [["space.page"
                                (ctob/make-token
                                 :id (cthi/new-id! :mobile-space)
                                 :name "space.page"
                                 :type :spacing
                                 :value 16)]]))
                    (ctob/add-set
                     (ctob/make-token-set
                      :id (cthi/new-id! :desktop-set)
                      :name "Device/Desktop"
                      :tokens [["space.page"
                                (ctob/make-token
                                 :id (cthi/new-id! :desktop-space)
                                 :name "space.page"
                                 :type :spacing
                                 :value 24)]]))
                    (ctob/add-theme
                     (ctob/make-token-theme
                      :id (cthi/new-id! :mobile-theme)
                      :group "Device"
                      :name "Mobile"
                      :sets #{"Device/Mobile"}))
                    (ctob/add-theme
                     (ctob/make-token-theme
                      :id (cthi/new-id! :desktop-theme)
                      :group "Device"
                      :name "Desktop"
                      :sets #{"Device/Desktop"}))))))

(defn setup-file-with-matrix-token-lib
  []
  (let [file (setup-file-with-matrix-token-lib-legacy)]
    (assoc-in file [:data :tokens-status]
              (cfo/make-tokens-status-from-lib (get-in file [:data :tokens-lib])))))

(t/deftest create-token-in-sets-copies-the-initial-value-once
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          store (ths/setup-store file)
          token (ctob/make-token :name "radius.card"
                                 :type :border-radius
                                 :value 12)
          events [(dwtl/create-token-in-sets
                   [(cthi/id :mobile-set) (cthi/id :desktop-set)]
                   token)]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               mobile-token (get (ctob/get-tokens lib (cthi/id :mobile-set))
                                 "radius.card")
               desktop-token (get (ctob/get-tokens lib (cthi/id :desktop-set))
                                  "radius.card")]
           (t/is (= [12 12] (mapv :value [mobile-token desktop-token])))
           (t/is (not= (:id mobile-token) (:id desktop-token)))))))))

(t/deftest duplicate-matrix-variant-copies-the-first-column-independently
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          store (ths/setup-store file)
          events [(dwtl/duplicate-token-matrix-variant
                   "Device"
                   (cthi/id :mobile-set))
                  (dwtl/update-token
                   (cthi/id :mobile-set)
                   (cthi/id :mobile-space)
                   {:value 20})]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               themes (remove ctob/hidden-theme? (ctob/get-themes lib))
               copied-theme (first (remove #(contains? #{"Mobile" "Desktop"}
                                                       (:name %))
                                           themes))
               copied-set-name (first (:sets copied-theme))
               copied-set (ctob/get-set-by-name lib copied-set-name)
               source-token (get (ctob/get-tokens lib (cthi/id :mobile-set))
                                 "space.page")
               copied-token (get (ctob/get-tokens lib (ctob/get-id copied-set))
                                 "space.page")]
           (t/is (= 3 (count themes)))
           (t/is (= "Device" (:group copied-theme)))
           (t/is (spts/theme-active? lib (ctob/get-id copied-theme)))
           (t/is (= 20 (:value source-token)))
           (t/is (= 16 (:value copied-token)))
           (t/is (not= (ctob/get-id copied-set) (cthi/id :mobile-set)))
           (t/is (not= (:id copied-token) (:id source-token)))))))))

(t/deftest create-matrix-domain-adds-and-activates-a-real-default-pair
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          store (ths/setup-store file)
          events [(dwtl/create-token-matrix-domain "Mode")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               token-set (ctob/get-set-by-name lib "Mode/Default")
               token-theme (ctob/get-theme-by-name lib "Mode" "Default")]
           (t/is (some? token-set))
           (t/is (empty? (ctob/get-tokens lib (ctob/get-id token-set))))
           (t/is (= #{"Mode/Default"} (:sets token-theme)))
           (t/is (spts/theme-active? lib (ctob/get-id token-theme)))))))))

(t/deftest create-first-theme-from-a-file-without-a-token-library
  (t/async
    done
    (let [store (ths/setup-store (setup-file))
          events [(dwtl/create-token-matrix-domain "Theme")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [lib (-> new-state ths/get-file-from-state current-tokens-library)
               token-set (ctob/get-set-by-name lib "Theme/Default")
               token-theme (ctob/get-theme-by-name lib "Theme" "Default")]
           (t/is (some? token-set))
           (t/is (some? token-theme))
           (t/is (spts/theme-active? lib (ctob/get-id token-theme)))))))))

(t/deftest activate-matrix-variant-preserves-other-domain-selections
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          mode-theme (ctob/make-token-theme
                      :id (cthi/new-id! :mode-theme)
                      :group "Mode"
                      :name "Light"
                      :sets #{"Mode/Light"})
          mode-set (ctob/make-token-set
                    :id (cthi/new-id! :mode-set)
                    :name "Mode/Light")
          file (-> file
                   (update-in [:data :tokens-lib] ctob/add-set mode-set)
                   (update-in [:data :tokens-lib] ctob/add-theme mode-theme)
                   (activate-file-theme (ctob/get-id mode-theme)))
          store (ths/setup-store file)
          events [(dwtl/activate-token-matrix-variant
                   "Device"
                   (cthi/id :desktop-set))]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')]
           (t/is (spts/theme-active? lib (cthi/id :desktop-theme)))
           (t/is (spts/theme-active? lib (cthi/id :mode-theme)))
           (t/is (not (spts/theme-active? lib (cthi/id :mobile-theme))))))))))

(t/deftest rename-matrix-variant-keeps-the-set-theme-pair-active
  (t/async
    done
    (let [file (-> (setup-file-with-matrix-token-lib)
                   (activate-file-theme (cthi/id :mobile-theme)))
          store (ths/setup-store file)
          events [(dwtl/rename-token-matrix-variant
                   "Device"
                   (cthi/id :mobile-set)
                   "Phone")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               token-set (ctob/get-set lib (cthi/id :mobile-set))
               token-theme (ctob/get-theme lib (cthi/id :mobile-theme))]
           (t/is (= "Device/Phone" (ctob/get-name token-set)))
           (t/is (= "Phone" (:name token-theme)))
           (t/is (= #{"Device/Phone"} (:sets token-theme)))
           (t/is (spts/theme-active? lib (cthi/id :mobile-theme)))))))))

(t/deftest rename-matrix-domain-does-not-rename-an-unrelated-same-group-theme
  (t/async
    done
    (let [other-set (ctob/make-token-set
                     :id (cthi/new-id! :other-set)
                     :name "Other/Blue")
          other-theme (ctob/make-token-theme
                       :id (cthi/new-id! :other-theme)
                       :group "Device"
                       :name "Unrelated"
                       :sets #{"Other/Blue"})
          file (-> (setup-file-with-matrix-token-lib)
                   (update-in [:data :tokens-lib] ctob/add-set other-set)
                   (update-in [:data :tokens-lib] ctob/add-theme other-theme))
          store (ths/setup-store file)
          events [(dwtl/rename-token-matrix-domain ["Device"] "Viewport")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [lib (-> new-state ths/get-file-from-state current-tokens-library)
               theme (ctob/get-theme lib (cthi/id :other-theme))]
           (t/is (= "Device" (:group theme)))
           (t/is (= #{"Other/Blue"} (:sets theme)))
           (t/is (some? (ctob/get-set-by-name lib "Viewport/Mobile")))))))))

(t/deftest delete-matrix-domain-preserves-unrelated-and-mixed-themes
  (t/async
    done
    (let [other-set (ctob/make-token-set
                     :id (cthi/new-id! :other-set)
                     :name "Other/Blue")
          unrelated-theme (ctob/make-token-theme
                           :id (cthi/new-id! :other-theme)
                           :group "Device"
                           :name "Unrelated"
                           :sets #{"Other/Blue"})
          mixed-theme (ctob/make-token-theme
                       :id (cthi/new-id! :mixed-theme)
                       :group "Device"
                       :name "Mixed"
                       :sets #{"Device/Mobile" "Other/Blue"})
          file (-> (setup-file-with-matrix-token-lib)
                   (update-in [:data :tokens-lib] ctob/add-set other-set)
                   (update-in [:data :tokens-lib] ctob/add-theme unrelated-theme)
                   (update-in [:data :tokens-lib] ctob/add-theme mixed-theme))
          store (ths/setup-store file)
          events [(dwtl/delete-token-matrix-domain ["Device"])]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [lib (-> new-state ths/get-file-from-state current-tokens-library)]
           (t/is (nil? (ctob/get-set-by-name lib "Device/Mobile")))
           (t/is (= #{"Other/Blue"}
                    (:sets (ctob/get-theme lib (cthi/id :other-theme)))))
           (t/is (= #{"Other/Blue"}
                    (:sets (ctob/get-theme lib (cthi/id :mixed-theme)))))))))))

(t/deftest deleting-the-active-matrix-variant-activates-the-first-remaining-column
  (t/async
    done
    (let [file (-> (setup-file-with-matrix-token-lib)
                   (activate-file-theme (cthi/id :mobile-theme)))
          store (ths/setup-store file)
          events [(dwtl/delete-token-matrix-variant
                   "Device"
                   (cthi/id :mobile-set))]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')]
           (t/is (nil? (ctob/get-set lib (cthi/id :mobile-set))))
           (t/is (nil? (ctob/get-theme lib (cthi/id :mobile-theme))))
           (t/is (spts/theme-active? lib (cthi/id :desktop-theme)))))))))

(t/deftest add-set
  (t/async
    done
    (let [file   (setup-file-with-token-lib)
          store  (ths/setup-store file)
          events [(dwtl/create-token-set (ctob/make-token-set :name "Set B"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               sets'       (ctob/get-sets tokens-lib')
               set-b'      (ctob/get-set-by-name tokens-lib' "Set B")]

           (t/testing "Token lib contains two sets"
             (t/is (= (count sets') 2))
             (t/is (some? set-b')))))))))

(t/deftest add-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/create-token-set (ctob/make-token-set :name "Set A"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest rename-set
  (t/async
    done
    (let [file       (setup-file-with-token-lib)
          store      (ths/setup-store file)
          tokens-lib (current-tokens-library file)
          set-a      (ctob/get-set-by-name tokens-lib "Set A")
          events     [(dwtl/rename-token-set set-a "Set A updated")]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               sets'       (ctob/get-sets tokens-lib')
               set-a'      (ctob/get-set-by-name tokens-lib' "Set A updated")]

           (t/testing "Set has been renamed"
             (t/is (= (count sets') 1))
             (t/is (some? set-a')))))))))

(t/deftest rename-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          set-a  (ctob/make-token-set :name "Set A")
          events [(dwtl/rename-token-set set-a "Set A updated")]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest duplicate-set
  (t/async
    done
    (let [file   (setup-file-with-token-lib)
          store  (ths/setup-store file)
          events [(dwtl/duplicate-token-set (cthi/id :test-token-set))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'     (ths/get-file-from-state new-state)
               token-lib (current-tokens-library file')
               sets      (ctob/get-sets token-lib)]

           (t/testing "Token lib contains two sets"
             (t/is (= (count sets) 2)))))))))

(t/deftest duplicate-non-exist-set
  (t/async
    done
    (let [file   (setup-file-with-token-lib)
          store  (ths/setup-store file)
          events [(dwtl/duplicate-token-set (uuid/next))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'     (ths/get-file-from-state new-state)
               token-lib (current-tokens-library file')
               sets      (ctob/get-sets token-lib)]

           (t/testing "Token lib contains one set"
             (t/is (= (count sets) 1)))))))))

(t/deftest duplicate-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/duplicate-token-set (uuid/next))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest delete-set
  (t/async
    done
    (let [file       (setup-file-with-token-lib)
          store      (ths/setup-store file)
          events     [(dwtl/delete-token-set (cthi/id :test-token-set))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               sets'       (ctob/get-sets tokens-lib')]

           (t/testing "Set has been deleted"
             (t/is (= (count sets') 0)))))))))

(t/deftest delete-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/delete-token-set (uuid/next))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest set-tokens-source
  (t/async
    done
    (let [file       (setup-file-with-token-lib)
          store      (ths/setup-store file)
          library-id (uuid/next)]

      ;; Phase 1: set tokens-source with undo watcher active
      (tohs/run-store
       store identity
       [(tohs/watch-undo-stack)
        (dwtl/set-tokens-source library-id)]
       (fn [new-state]
         (let [file-data' (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "tokens-source is set to the library id"
             (t/is (= library-id (:tokens-source file-data'))))))
       (tohs/stop-on ::dwtl/set-tokens-source))

      ;; Phase 2: undo and verify restoration
      (tohs/run-store
       store done
       [dwu/undo]
       (fn [undone-state]
         (let [file-data'' (-> (ths/get-file-from-state undone-state) :data)]
           (t/testing "tokens-source is restored to nil"
             (t/is (nil? (:tokens-source file-data''))))))
       (tohs/stop-on ::dwu/undo)))))

(t/deftest set-tokens-source-no-tokens-lib
  (t/async
    done
    (let [file       (setup-file)
          store      (ths/setup-store file)
          library-id (uuid/next)]

      (tohs/run-store-async
       store done
       [(dwtl/set-tokens-source library-id)]
       (fn [new-state]
         (let [file-data' (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "tokens-source is set even without tokens-lib"
             (t/is (= library-id (:tokens-source file-data'))))))))))

;; ==========================================================================
;; Token Themes
;; ==========================================================================

(t/deftest create-token-theme
  (t/async
    done
    (let [file      (setup-file-with-token-lib)
          store     (ths/setup-store file)
          theme-id  (uuid/next)
          events    [(dwtl/create-token-theme (ctob/make-token-theme :id theme-id
                                                                     :name "Theme B"
                                                                     :group "default"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               theme'      (ctob/get-theme tokens-lib' theme-id)]

           (t/testing "Theme has been created"
             (t/is (some? theme'))
             (t/is (= "Theme B" (:name theme'))))))))))

(t/deftest create-token-theme-no-tokens-lib
  (t/async
    done
    (let [file     (setup-file)
          store    (ths/setup-store file)
          theme-id (uuid/next)
          events   [(dwtl/create-token-theme (ctob/make-token-theme :id theme-id
                                                                    :name "Theme A"
                                                                    :group "default"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest update-token-theme
  (t/async
    done
    (let [theme-id (uuid/next)
          file     (setup-file-with-token-lib-and-theme theme-id)
          store    (ths/setup-store file)
          events   [(dwtl/update-token-theme theme-id
                                             (ctob/make-token-theme :id theme-id
                                                                    :name "Theme A renamed"
                                                                    :group "default"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               theme'      (ctob/get-theme tokens-lib' theme-id)]

           (t/testing "Theme has been renamed"
             (t/is (= "Theme A renamed" (:name theme'))))))))))

(t/deftest update-token-theme-no-tokens-lib
  (t/async
    done
    (let [file     (setup-file)
          store    (ths/setup-store file)
          theme-id (uuid/next)
          events   [(dwtl/update-token-theme theme-id
                                             (ctob/make-token-theme :id theme-id
                                                                    :name "Theme A"
                                                                    :group "default"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest set-token-theme-active
  (t/async
    done
    (let [file      (setup-file-with-token-lib)
          store     (ths/setup-store file)
          theme-id  (uuid/next)
          events    [(dwtl/create-token-theme (ctob/make-token-theme :id theme-id
                                                                     :name "Theme B"
                                                                     :group "default"))
                     (dwtl/set-token-theme-active theme-id true)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'         (ths/get-file-from-state new-state)
               tokens-status (ctho/get-tokens-status file')]

           (t/testing "Theme has been activated"
             (t/is (ctos/theme-active? tokens-status theme-id)))))))))

(t/deftest set-token-theme-active-no-tokens-lib
  (t/async
    done
    (let [file     (setup-file)
          store    (ths/setup-store file)
          theme-id (uuid/next)
          events   [(dwtl/set-token-theme-active theme-id true)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest toggle-token-theme-active
  (t/async
    done
    (let [theme-id (uuid/next)
          file     (setup-file-with-token-lib-and-theme theme-id)
          store    (ths/setup-store file)
          events   [(dwtl/toggle-token-theme-active theme-id)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'         (ths/get-file-from-state new-state)
               tokens-status (ctho/get-tokens-status file')]

           (t/testing "Theme has been deactivated"
             (t/is (not (ctos/theme-active? tokens-status theme-id))))))))))

(t/deftest toggle-token-theme-active-no-tokens-lib
  (t/async
    done
    (let [file     (setup-file)
          store    (ths/setup-store file)
          theme-id (uuid/next)
          events   [(dwtl/toggle-token-theme-active theme-id)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest delete-token-theme
  (t/async
    done
    (let [theme-id (uuid/next)
          file     (setup-file-with-token-lib-and-theme theme-id)
          store    (ths/setup-store file)
          events   [(dwtl/delete-token-theme theme-id)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               theme'      (ctob/get-theme tokens-lib' theme-id)]

           (t/testing "Theme has been deleted"
             (t/is (nil? theme')))))))))

(t/deftest delete-token-theme-no-tokens-lib
  (t/async
    done
    (let [file     (setup-file)
          store    (ths/setup-store file)
          theme-id (uuid/next)
          events   [(dwtl/delete-token-theme theme-id)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

;; ==========================================================================
;; Token Set Operations
;; ==========================================================================

(t/deftest set-enabled-token-set
  (t/async
    done
    (let [file   (setup-file-with-token-lib)
          store  (ths/setup-store file)
          events [(dwtl/set-enabled-token-set (cthi/id :test-token-set) true)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'         (ths/get-file-from-state new-state)
               tokens-status (ctho/get-tokens-status file')]

           (t/testing "Set has been enabled"
             (t/is (ctos/set-active? tokens-status (cthi/id :test-token-set))))))))))

(t/deftest set-enabled-token-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/set-enabled-token-set (uuid/next) true)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest toggle-token-set
  (t/async
    done
    (let [file   (setup-file-with-token-lib)
          store  (ths/setup-store file)
          events [(dwtl/toggle-token-set (cthi/id :test-token-set))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'         (ths/get-file-from-state new-state)
               tokens-status (ctho/get-tokens-status file')]

           (t/testing "Set has been toggled (deactivated)"
             (t/is (not (ctos/set-active? tokens-status (cthi/id :test-token-set)))))))))))

(t/deftest toggle-token-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/toggle-token-set (uuid/next))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest toggle-token-set-group
  (t/async
    done
    (let [file   (ctho/sample-file-with-tokens
                  :file-id :file-1
                  :page-label :page-1
                  :lib-fn #(-> %
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-a)
                                                                  :name "group/set-a"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-b)
                                                                  :name "group/set-b")))
                  :status-fn #(ctos/set-tokens-status % #{} #{}))
          store  (ths/setup-store file)
          events [(dwtl/toggle-token-set-group ["group"])]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'         (ths/get-file-from-state new-state)
               tokens-status (ctho/get-tokens-status file')]

           (t/testing "Set group has been toggled (activated)"
             (t/is (ctos/set-active? tokens-status (cthi/id :set-a)))
             (t/is (ctos/set-active? tokens-status (cthi/id :set-b))))))))))

(t/deftest toggle-token-set-group-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/toggle-token-set-group ["group"])]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest delete-token-set-group
  (t/async
    done
    (let [file   (ctho/sample-file-with-tokens
                  :file-id :file-1
                  :page-label :page-1
                  :lib-fn #(-> %
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-a)
                                                                  :name "group/set-a"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-b)
                                                                  :name "group/set-b"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-c)
                                                                  :name "other/set-c"))))
          store  (ths/setup-store file)
          events [(dwtl/delete-token-set-group ["group"])]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')]

           (t/testing "Group sets deleted, other set remains"
             (t/is (nil? (ctob/get-set-by-name tokens-lib' "group/set-a")))
             (t/is (nil? (ctob/get-set-by-name tokens-lib' "group/set-b")))
             (t/is (some? (ctob/get-set-by-name tokens-lib' "other/set-c"))))))))))

(t/deftest delete-token-set-group-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/delete-token-set-group ["group"])]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest rename-token-set-group
  (t/async
    done
    (let [file   (ctho/sample-file-with-tokens
                  :file-id :file-1
                  :page-label :page-1
                  :lib-fn #(ctob/add-set % (ctob/make-token-set :id (cthi/new-id! :set-a)
                                                                :name "old-group/set-a")))
          store  (ths/setup-store file)
          events [(dwtl/rename-token-set-group ["old-group"] "new-group")]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')]

           (t/testing "Set group has been renamed"
             (t/is (some? (ctob/get-set-by-name tokens-lib' "new-group/set-a")))
             (t/is (nil? (ctob/get-set-by-name tokens-lib' "old-group/set-a"))))))))))

(t/deftest rename-token-set-group-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/rename-token-set-group ["old-group"] "new-group")]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

;; ==========================================================================
;; Drop Operations
;; ==========================================================================

(t/deftest drop-token-set-group
  (t/async
    done
    (let [file   (ctho/sample-file-with-tokens
                  :file-id :file-1
                  :page-label :page-1
                  :lib-fn #(-> %
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-a)
                                                                  :name "foo/foo"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-b)
                                                                  :name "bar/bar"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-c)
                                                                  :name "baz/baz"))))
          store  (ths/setup-store file)
          events [(dwtl/drop-token-set-group {:from-index 2
                                              :to-index 0
                                              :position :top})]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               sets'       (ctob/get-set-names tokens-lib')]

           (t/testing "Set groups have been reordered"
             (t/is (= ["bar/bar" "foo/foo" "baz/baz"] (vec sets'))))))))))

(t/deftest drop-token-set-group-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/drop-token-set-group {:from-index 0
                                              :to-index 1
                                              :position :top})]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest drop-token-set
  (t/async
    done
    (let [file   (ctho/sample-file-with-tokens
                  :file-id :file-1
                  :page-label :page-1
                  :lib-fn #(-> %
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-a)
                                                                  :name "foo"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-b)
                                                                  :name "bar"))
                               (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-c)
                                                                  :name "baz"))))
          store  (ths/setup-store file)
          events [(dwtl/drop-token-set {:from-index 0
                                        :to-index 2
                                        :position :bot})]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               sets'       (ctob/get-set-names tokens-lib')]

           (t/testing "Token sets have been reordered"
             (t/is (= ["bar" "baz" "foo"] (vec sets'))))))))))

(t/deftest drop-token-set-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/drop-token-set {:from-index 0
                                        :to-index 1
                                        :position :top})]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

;; ==========================================================================
;; Token CRUD
;; ==========================================================================

(t/deftest create-token-in-set
  (t/async
    done
    (let [file      (setup-file-with-token-lib)
          store     (ths/setup-store file)
          token-id  (cthi/new-id! :color.primary)
          events    [(dwtl/create-token (cthi/id :test-token-set)
                                        (ctob/make-token :id token-id
                                                         :name "color.primary"
                                                         :type :color
                                                         :value "#000000"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               token       (ctob/get-token tokens-lib' (cthi/id :test-token-set)
                                           (cthi/id :color.primary))]

           (t/testing "Token has been created in set"
             (t/is (some? token)))))))))

(t/deftest create-token-no-set
  (t/async
    done
    (let [file      (setup-file)
          store     (ths/setup-store file)
          token-id  (cthi/new-id! :color.primary)
          events    [(dwtl/create-token (ctob/make-token :id token-id
                                                         :name "color.primary"
                                                         :type :color
                                                         :value "#000000"))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')]

           (t/testing "Global set has been created with the token"
             (t/is (some? tokens-lib'))
             (t/is (some? (ctob/get-set-by-name tokens-lib' "Global"))))))))))

(t/deftest update-token
  (t/async
    done
    (let [file   (setup-file-with-token-lib-and-token)
          store  (ths/setup-store file)
          events [(dwtl/update-token (cthi/id :test-token-set)
                                     (cthi/id :color.primary)
                                     {:value "#ffffff"
                                      :name "color.primary.updated"})]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               token'      (ctob/get-token tokens-lib' (cthi/id :test-token-set)
                                           (cthi/id :color.primary))]

           (t/testing "Token has been updated"
             (t/is (= "color.primary.updated" (:name token')))
             (t/is (= "#ffffff" (:value token'))))))))))

(t/deftest update-token-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/update-token (uuid/next) (uuid/next) {:value "#ffffff"})]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest delete-token
  (t/async
    done
    (let [file   (setup-file-with-token-lib-and-token)
          store  (ths/setup-store file)
          events [(dwtl/delete-token (cthi/id :test-token-set)
                                     (cthi/id :color.primary))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               token'      (ctob/get-token tokens-lib' (cthi/id :test-token-set)
                                           (cthi/id :color.primary))]

           (t/testing "Token has been deleted"
             (t/is (nil? token')))))))))

(t/deftest delete-token-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/delete-token (uuid/next) (uuid/next))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

(t/deftest duplicate-token
  (t/async
    done
    (let [file   (setup-file-with-token-lib-and-token)
          store  (ths/setup-store file)
          events [(dwtl/set-selected-token-set-id (cthi/id :test-token-set))
                  (dwtl/duplicate-token (cthi/id :color.primary))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')
               tokens      (ctob/get-tokens tokens-lib' (cthi/id :test-token-set))]

           (t/testing "Token has been duplicated"
             (t/is (= 2 (count tokens))))))))))

(t/deftest duplicate-token-no-tokens-lib
  (t/async
    done
    (let [file   (setup-file)
          store  (ths/setup-store file)
          events [(dwtl/duplicate-token (uuid/next))]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file-data (-> (ths/get-file-from-state new-state) :data)]
           (t/testing "No crash when file has no tokens-lib"
             (t/is (some? file-data)))))))))

;; ==========================================================================
;; Import Tokens Lib
;; ==========================================================================

(t/deftest import-tokens-lib
  (t/async
    done
    (let [file      (setup-file)
          store     (ths/setup-store file)
          new-lib   (-> (ctob/make-tokens-lib)
                        (ctob/add-set (ctob/make-token-set :name "Imported Set")))
          events    [(dwtl/import-tokens-lib new-lib)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')]

           (t/testing "Tokens lib has been imported"
             (t/is (some? tokens-lib'))
             (t/is (some? (ctob/get-set-by-name tokens-lib' "Imported Set"))))))))))

(t/deftest import-tokens-lib-no-tokens-lib
  (t/async
    done
    (let [file      (setup-file)
          store     (ths/setup-store file)
          new-lib   (-> (ctob/make-tokens-lib)
                        (ctob/add-set (ctob/make-token-set :name "Imported Set")))
          events    [(dwtl/import-tokens-lib new-lib)]]

      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file'       (ths/get-file-from-state new-state)
               tokens-lib' (current-tokens-library file')]
           (t/testing "Tokens lib has been imported into file without existing lib"
             (t/is (some? tokens-lib'))
             (t/is (some? (ctob/get-set-by-name tokens-lib' "Imported Set"))))))))))
