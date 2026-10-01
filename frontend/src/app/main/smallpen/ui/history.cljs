;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.history
  "SmallPen additions to the workspace History panel: Token library
  changes get their own rows, and one undo group (a token edit and its
  propagation) is one row. Outside SmallPen every function leaves
  Penpot's history unchanged."
  (:require
   [app.common.data :as d]
   [app.main.smallpen :as smallpen]))

(def ^:private token-types
  #{:token :token-set :token-theme})

(defn token-type?
  [type]
  (contains? token-types type))

(defn- token-operation
  "Token library changes carry nil attrs on the side where the item does
  not exist: nil redo attrs delete it, nil undo attrs create it."
  [change undo-change]
  (cond
    (nil? (:attrs change)) :delete
    (nil? (:attrs undo-change)) :new
    :else :modify))

(defn token-change
  "Parse a Token library change, given the undo change that reverts it.
  Nil for any other change, and outside SmallPen, where Penpot does not
  list token changes."
  [change undo-change]
  (when (smallpen/enabled?)
    (let [r (fn [type id operation]
              {:type type :operation operation :detail nil :id id})]
      (case (:type change)
        :set-token (r :token (:token-id change) (token-operation change undo-change))
        :set-token-set (r :token-set (:id change) (token-operation change undo-change))
        :set-token-theme (r :token-theme (:id change) (token-operation change undo-change))
        (:set-active-token-themes :set-tokens-status) (r :token-theme :multiple :modify)
        :rename-token-set-group (r :token-set (last (:set-group-path change)) :modify)
        nil))))

(defn- undo-change-key
  [change]
  (case (:type change)
    :set-token [(:set-id change) (:token-id change)]
    (:set-token-set :set-token-theme) (:id change)
    nil))

(defn paired-undo-changes
  "The undo change that reverts each redo change of `entry`, in redo
  order. Redo and undo lists are not 1:1 (one `:mov-objects` is undone by
  several changes, some redo changes have no undo), so a change pairs with
  an undo change of the same type and id, or else by order within its
  type. Only token changes use the pair, so outside SmallPen it is nil."
  [{:keys [redo-changes undo-changes]}]
  (if-not (smallpen/enabled?)
    (repeat nil)
    (let [undo-by-type (group-by :type (reverse undo-changes))]
      (first
       (reduce (fn [[result seen] change]
                 (let [type       (:type change)
                       index      (get seen type 0)
                       key        (undo-change-key change)
                       candidates (get undo-by-type type)
                       undo       (or (when (some? key)
                                        (d/seek #(= key (undo-change-key %)) candidates))
                                      (nth candidates index nil))]
                   [(conj result undo)
                    (assoc seen type (inc index))]))
               [[] {}]
               redo-changes)))))

(defn token-action-entry
  "Token edits can also update paired Themes and concrete shape values.
  Present those implementation details as one Token action. `entries` are
  the parsed changes grouped by `[type operation id]`."
  [entries shape-type?]
  (let [types (group-by first (keys entries))]
    (when (and (seq types)
               (some token-types (keys types))
               (every? #(or (token-type? %) (shape-type? %)) (keys types)))
      (let [preferred-type (cond
                             (contains? types :token) :token
                             (contains? types :token-set) :token-set
                             :else :token-theme)
            preferred-keys (filter #(= preferred-type (first %))
                                   (keys entries))
            preferred-operation
            (cond
              (some #(= :new (second %)) preferred-keys) :new
              (some #(= :delete (second %)) preferred-keys) :delete
              (some #(= :modify (second %)) preferred-keys) :modify
              :else :multiple)
            preferred-keys (filter #(= preferred-operation (second %))
                                   preferred-keys)]
        {:type preferred-type
         :operation preferred-operation
         :id (if (= 1 (count preferred-keys))
               (-> preferred-keys first last)
               :multiple)}))))

(defn index-undo-entries
  "Tags each undo entry with its own stack index, one row per entry."
  [entries]
  (into []
        (map-indexed (fn [index entry]
                       (assoc entry
                              ::start-index index
                              ::end-index index)))
        entries))

(defn group-undo-entries
  "Coalesces adjacent undo entries that belong to one user action.
  The undo stack intentionally keeps propagation commits separate, but
  history should present the shared undo group as a single selectable row."
  [entries]
  (reduce-kv
   (fn [groups index entry]
     (let [entry (assoc entry
                        ::start-index index
                        ::end-index index)
           previous (peek groups)]
       (if (and previous
                (some? (:undo-group entry))
                (= (:undo-group previous) (:undo-group entry)))
         (conj (pop groups)
               (-> previous
                   (update :redo-changes into (:redo-changes entry))
                   (update :undo-changes #(into (:undo-changes entry) %))
                   (assoc ::end-index index
                          :selected-after (:selected-after entry))))
         (conj groups entry))))
   []
   (vec entries)))

(defn undo-rows
  "History rows for the undo stack items, each tagged with the stack
  indexes it covers: SmallPen shows one row per undo group, Penpot one
  row per undo entry."
  [items]
  (if (smallpen/enabled?)
    (group-undo-entries items)
    (index-undo-entries items)))
