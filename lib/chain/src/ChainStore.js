let Immutable = require("immutable");
let {Apis} = require("2ab2-ws-js");
let {object_type, impl_object_type} = require("./ChainTypes");
let ChainValidation = require("./ChainValidation");
let BigInteger = require("bigi");
let moment = require('moment');
let ee = require("./EmitterInstance");

let emitter = ee.emitter();
let op_history = parseInt(object_type.operation_history, 10);
let limit_order = parseInt(object_type.limit_order, 10);
let call_order = parseInt(object_type.call_order, 10);
let proposal = parseInt(object_type.proposal, 10);
let balance_type = parseInt(object_type.balance, 10);
let vesting_balance_type = parseInt(object_type.vesting_balance, 10);
let witness_object_type = parseInt(object_type.witness, 10);
let worker_object_type = parseInt(object_type.worker, 10);
let committee_member_object_type = parseInt(object_type.committee_member, 10);
let account_object_type = parseInt(object_type.account, 10);
let asset_object_type = parseInt(object_type.asset, 10);

let order_prefix = "1." + limit_order + ".";
let call_order_prefix = "1." + call_order + ".";
let proposal_prefix = "1." + proposal + ".";
let balance_prefix = "2." + parseInt(impl_object_type.account_balance, 10) + ".";
let account_stats_prefix = "2." + parseInt(impl_object_type.account_statistics, 10) + ".";
let asset_dynamic_data_prefix = "2." + parseInt(impl_object_type.asset_dynamic_data, 10) + ".";
let bitasset_data_prefix = "2." + parseInt(impl_object_type.asset_bitasset_data, 10) + ".";
let vesting_balance_prefix = "1." + vesting_balance_type + ".";
let witness_prefix = "1." + witness_object_type + ".";
let worker_prefix = "1." + worker_object_type + ".";
let committee_prefix = "1." + committee_member_object_type + ".";
let asset_prefix = "1." + asset_object_type + ".";
let account_prefix = "1." + account_object_type + ".";

const DEBUG = JSON.parse(process.env.npm_config__graphene_chain_chain_debug || false);

/**
 *  @brief maintains a local cache of blockchain state
 *
 *  The ChainStore maintains a local cache of blockchain state and exposes
 *  an API that makes it easy to query objects and receive updates when
 *  objects are available.
 */
class ChainStore {
	constructor() {
		/** tracks everyone who wants to receive updates when the cache changes */
		this.subscribers = new Set();
		this.subscribed = false;
		this.clearCache();
		this.progress = 0;
		// this.chain_time_offset is used to estimate the blockchain time
		this.chain_time_offset = [];
		this.dispatchFrequency = 40;
	}
	
	/**
	 * Clears all cached state.  This should be called any time the network connection is
	 * reset.
	 */
	clearCache() {
		this.objects_by_id = Immutable.Map();
		this.accounts_by_name = Immutable.Map();
		this.accounts_by_address = Immutable.Map();
		this.assets_by_symbol = Immutable.Map();
		this.account_ids_by_key = Immutable.Map();
		this.balance_objects_by_address = Immutable.Map();
		this.get_account_refs_of_keys_calls = Immutable.Set();
		this.account_history_requests = new Map(); ///< tracks pending history requests
		this.witness_by_account_id = new Map();
		this.committee_by_account_id = new Map();
		this.objects_by_vote_id = new Map();
		this.fetching_get_full_accounts = new Map();
		this.fetching_by_address = new Map();
		this.account_sum_transfers_by_asset = Immutable.Map();
		this.is_actual_history = new Map();
		this.get_asset_await = Immutable.Map();
		this.get_asset_by_symbol_promise = {};
		this.get_asset_by_id_promise = {};
		this.transfers_by_account = Immutable.Map();
		this.all_transfers_by_account = Immutable.Map();
		this.fetching_transfers_by_account = Immutable.Map();
		this.blocks = Immutable.Map();
		this.mining_period_transfers = Immutable.List();
		this.fetching_names_or_ids = new Set();
	}
	
	resetCache() {
		this.subscribed = false;
		this.clearCache();
		this.head_block_time_string = null;
		this.init().then(result => {
			console.log("resetCache init success");
		}).catch(err => {
			console.log("resetCache init error:", err);
		});
	}
	
	checkIsInCache(id) {
		return this.objects_by_id.has(id);
	}
	
	checkIsActualHistory(id) {
		return this.is_actual_history.has(id) && this.is_actual_history.get(id);
	}
	
	setAsActualHistory(id) {
		this.is_actual_history = this.is_actual_history.set(id, true);
	}
	
	setDispatchFrequency(freq) {
		this.dispatchFrequency = freq;
	}
	
	init() {
		let reconnectCounter = 0;
		let _init = (resolve, reject) => {
			let db_api = Apis.instance().db_api();
			if(!db_api) {
				return reject(new Error("Api not found, please initialize the api instance before calling the ChainStore"));
			}
			return db_api.exec("get_objects", [["2.1.0"]]).then(optional_objects => {
				//if(DEBUG) console.log('... optional_objects',optional_objects ? optional_objects[0].id : null)
				for(let i = 0; i < optional_objects.length; i++) {
					let optional_object = optional_objects[i];
					if(optional_object) {
						
						this._updateObject(optional_object, true);
						
						let head_time = new Date(optional_object.time + "+00:00").getTime();
						this.head_block_time_string = optional_object.time;
						this.chain_time_offset.push(new Date().getTime() - timeStringToDate(optional_object.time).getTime());
						let now = new Date().getTime();
						let delta = (now - head_time) / 1000;
						let start = Date.parse('Sep 1, 2015');
						let progress_delta = head_time - start;
						this.progress = progress_delta / (now - start);
						
						// if(delta < 60) {
						Apis.instance().db_api().exec("set_subscribe_callback", [this.onUpdate.bind(this), true]).then(v => {
							// console.log("synced and subscribed, chainstore ready");
							this.subscribed = true;
							resolve();
							
							let maintenanceTime = parseInt(moment.utc(optional_object.next_maintenance_time).format('X'));
							let now = parseInt(moment().format('X'));
							
							// setTimeout(() => {
							// 	console.log('cancel_all_subscriptions');
							// 	Apis.instance().db_api().exec("cancel_all_subscriptions", []).then(() => {
							// 		setTimeout(_init.bind(this, resolve, reject), (Math.floor(Math.random() * (480 - 180)) + 180) * 1000);
							// 	});
							// 	this.account_sum_transfers_by_asset = new Map();
							// }, (maintenanceTime - now - 2) * 1000);
						}).catch(error => {
							reject(error);
							console.log("Error: ", error);
						});
						// } else {
						// 	console.log("not yet synced, retrying in 1s");
						// 	reconnectCounter++;
						// 	if(reconnectCounter > 10) {
						// 		throw new Error("ChainStore sync error, please check your system clock");
						// 	}
						// 	setTimeout(_init.bind(this, resolve, reject), 1000);
						// }
					} else {
						setTimeout(_init.bind(this, resolve, reject), 1000);
					}
				}
			}).catch(error => {
				// in the event of an error clear the pending state for id
				console.log('!!! Chain API error', error);
				this.objects_by_id = this.objects_by_id.delete("2.1.0");
				reject(error);
			});
		};
		
		return new Promise((resolve, reject) => _init(resolve, reject));
	}
	
	onUpdate(updated_objects) /// map from account id to objects
	{
		for(let a = 0; a < updated_objects.length; ++a) {
			for(let i = 0; i < updated_objects[a].length; ++i) {
				let obj = updated_objects[a][i];
				
				if(ChainValidation.is_object_id(obj)) {
					/// the object was removed
					// Cancelled limit order, emit event for MarketStore to update it's state
					if(obj.search(order_prefix) == 0) {
						let old_obj = this.objects_by_id.get(obj);
						if(!old_obj) {
							return;
						}
						emitter.emit('cancel-order', old_obj.get("id"));
						let account = this.objects_by_id.get(old_obj.get("seller"));
						if(account && account.has("orders")) {
							let limit_orders = account.get("orders");
							if(account.get("orders").has(obj)) {
								account = account.set("orders", limit_orders.delete(obj));
								this.objects_by_id = this.objects_by_id.set(account.get("id"), account);
							}
						}
					}
					
					// Update nested call_order inside account object
					if(obj.search(call_order_prefix) == 0) {
						
						let old_obj = this.objects_by_id.get(obj);
						if(!old_obj) {
							return;
						}
						emitter.emit('close-call', old_obj.get("id"));
						let account = this.objects_by_id.get(old_obj.get("borrower"));
						if(account && account.has("call_orders")) {
							let call_orders = account.get("call_orders");
							if(account.get("call_orders").has(obj)) {
								account = account.set("call_orders", call_orders.delete(obj));
								this.objects_by_id = this.objects_by_id.set(account.get("id"), account);
							}
						}
					}
					
					// Remove the object
					this.objects_by_id = this.objects_by_id.set(obj, null);
				} else this._updateObject(obj, false);
			}
		}
		this.notifySubscribers();
	}
	
	notifySubscribers() {
		// Dispatch at most only once every x milliseconds
		if(!this.dispatched) {
			this.dispatched = true;
			setTimeout(() => {
				this.dispatched = false;
				this.subscribers.forEach(callback => {
					callback();
				});
			}, this.dispatchFrequency);
		}
	}
	
	/**
	 *  Add a callback that will be called anytime any object in the cache is updated
	 */
	subscribe(callback) {
		if(this.subscribers.has(callback)) console.error("Subscribe callback already exists", callback);
		this.subscribers.add(callback);
	}
	
	/**
	 *  Remove a callback that was previously added via subscribe
	 */
	unsubscribe(callback) {
		if(!this.subscribers.has(callback)) console.error("Unsubscribe callback does not exists", callback);
		this.subscribers.delete(callback);
	}
	
	/** Clear an object from the cache to force it to be fetched again. This may
	 * be useful if a query failed the first time and the wallet has reason to believe
	 * it may succeede the second time.
	 */
	clearObjectCache(id) {
		this.objects_by_id = this.objects_by_id.delete(id);
	}
	
	/**
	 * There are three states an object id could be in:
	 *
	 * 1. undefined       - returned if a query is pending
	 * 3. defined         - return an object
	 * 4. null            - query return null
	 *
	 */
	getObject(id, force = false) {
		if(id == '1.2.20') {
			return Immutable.fromJS({
				name: 'edinar',
				id: '1.2.20'
			});
		}
		if(!ChainValidation.is_object_id(id)) throw Error("argument is not an object id: " + JSON.stringify(id));
		
		let result = this.objects_by_id.get(id);
		if(result === undefined || force) return this.fetchObject(id, force);
		if(result === true) return undefined;
		
		return result;
	}
	
	/**
	 *  @return undefined if a query is pending
	 *  @return null if id_or_symbol has been queired and does not exist
	 *  @return object if the id_or_symbol exists
	 */
	getAsset(id_or_symbol) {
		if(!id_or_symbol) return null;
		
		if(ChainValidation.is_object_id(id_or_symbol)) {
			let asset = this.getObject(id_or_symbol);
			
			if(asset && asset.get("bitasset") && !asset.getIn(["bitasset", "current_feed"])) {
				return undefined;
			}
			return asset;
		}
		
		/// TODO: verify id_or_symbol is a valid symbol name
		
		let asset_id = this.assets_by_symbol.get(id_or_symbol);
		
		if(ChainValidation.is_object_id(asset_id)) {
			let asset = this.getObject(asset_id);
			
			if(asset && asset.get("bitasset") && !asset.getIn(["bitasset", "current_feed"])) {
				return undefined;
			}
			return asset;
		}
		
		if(asset_id === null) return null;
		
		if(asset_id === true) return undefined;
		
		if(this.get_asset_await.has(id_or_symbol) && this.get_asset_await.get(id_or_symbol)) return undefined;
		this.get_asset_await = this.get_asset_await.set(id_or_symbol, true);
		Apis.instance().db_api().exec("lookup_asset_symbols", [[id_or_symbol]]).then(asset_objects => {
			// console.log( "lookup symbol ", id_or_symbol )
			this.get_asset_await = this.get_asset_await.set(id_or_symbol, false);
			if(asset_objects.length && asset_objects[0]) this._updateObject(asset_objects[0], true); else {
				this.assets_by_symbol = this.assets_by_symbol.set(id_or_symbol, null);
				this.notifySubscribers();
			}
		}).catch(error => {
			console.log("Error: ", error);
			this.assets_by_symbol = this.assets_by_symbol.delete(id_or_symbol);
		});
		
		return undefined;
	}
	
	getAssetBySymbol(symbol) {
		return new Promise((success, fail) => {
			if(this.get_asset_by_symbol_promise[symbol]) {
				return this.get_asset_by_symbol_promise[symbol].push([success, fail]);
			}
			this.get_asset_by_symbol_promise[symbol] = [[success, fail]];
			let asset_id = this.assets_by_symbol.get(symbol);
			if(asset_id)
				return this.getAssetById(asset_id);
			
			Apis.instance().db_api().exec("lookup_asset_symbols", [[symbol]]).then(asset_objects => {
				if(!asset_objects.length || !asset_objects[0]) {
					this.get_asset_by_symbol_promise[symbol].forEach(([s, f]) => s(null));
					return delete this.get_asset_by_symbol_promise[symbol];
				}
				this.assets_by_symbol = this.assets_by_symbol.set(symbol, asset_objects[0].id);
				
				let asset = asset_objects[0];
				let result = this._updateObject(asset, true);
				this.get_asset_by_symbol_promise[symbol].forEach(([s, f]) => s(result));
				delete this.get_asset_by_symbol_promise[symbol];
			}).catch(error => {
				this.get_asset_by_symbol_promise[symbol].forEach(([s, f]) => f(error));
				return delete this.get_asset_by_symbol_promise[symbol];
			});
		});
	}
	
	getAssetById(asset_id) {
		return new Promise((success, fail) => {
			if(this.get_asset_by_id_promise[asset_id]) {
				return this.get_asset_by_id_promise[asset_id].push([success, fail]);
			}
			this.get_asset_by_id_promise[asset_id] = [[success, fail]];
			if(this.objects_by_id.get(asset_id)) {
				this.get_asset_by_id_promise[asset_id].forEach(([s, f]) => s(this.objects_by_id.get(asset_id)));
				return delete this.get_asset_by_id_promise[asset_id];
			}
			Apis.instance().db_api().exec("get_objects", [[asset_id]]).then(assets => {
				if(!assets.length || !assets[0]) {
					this.get_asset_by_id_promise[asset_id].forEach(([s, f]) => s(null));
					return delete this.get_asset_by_id_promise[asset_id];
				}
				let asset = assets[0];
				let result = this._updateObject(asset, true);
				this.get_asset_by_id_promise[asset_id].forEach(([s, f]) => s(result));
				delete this.get_asset_by_id_promise[asset_id];
			}).catch(error => {
				console.error(`Error in getAssetById (${asset_id})`, error);
				if(this.get_asset_by_id_promise[asset_id]) {
					this.get_asset_by_id_promise[asset_id].forEach(([s, f]) => f(error));
					delete this.get_asset_by_id_promise[asset_id];
				}
			});
		});
	}
	
	getAssetAsync(id_or_symbol) {
		return new Promise(success => {
			let asset = this.getAsset(id_or_symbol);
			if(asset !== undefined) {
				return success(asset);
			}
			setTimeout(() => {
				this.getAssetAsync(id_or_symbol).then(asset => success(asset));
			}, 200);
		});
	}
	
	/**
	 *  @param the public key to find accounts that reference it
	 *
	 *  @return Set of account ids that reference the given key
	 *  @return a empty Set if no items are found
	 *  @return undefined if the result is unknown
	 *
	 *  If this method returns undefined, then it will send a request to
	 *  the server for the current set of accounts after which the
	 *  server will notify us of any accounts that reference these keys
	 */
	getAccountRefsOfKey(key) {
		if(this.get_account_refs_of_keys_calls.has(key)) return this.account_ids_by_key.get(key); else {
			this.get_account_refs_of_keys_calls = this.get_account_refs_of_keys_calls.add(key);
			Apis.instance().db_api().exec('get_key_references', [[key]]).then(vec_account_id => {
				let refs = Immutable.Set();
				vec_account_id = vec_account_id[0];
				refs = refs.withMutations(r => {
					for(let i = 0; i < vec_account_id.length; ++i) {
						r.add(vec_account_id[i]);
					}
				});
				this.account_ids_by_key = this.account_ids_by_key.set(key, refs);
				this.notifySubscribers();
			}, error => {
				this.account_ids_by_key = this.account_ids_by_key.delete(key);
				this.get_account_refs_of_keys_calls = this.get_account_refs_of_keys_calls.delete(key);
			});
			return undefined;
		}
	}


	/**
	 * @param {Array<strings>} keys - array of public keys
	 * @return {Array<string | undefined>} id - [1.11.123213, undefined, undefined]
	 */
	async getAccountsIdByKeys(keys){
		const isAllKeysCached = keys.some(key=>{
			return this.get_account_refs_of_keys_calls.has(key);
		});
		if(isAllKeysCached) {
			const cachedKeys = keys.map(key=>this.account_ids_by_key.get(key).toJS());
			return cachedKeys;
		}
		const account_ids = await  Apis.instance().db_api().exec('get_key_references', [keys]);
		this.cacheAccountIdsAndRefs(account_ids, keys);
		return account_ids;
	}

	cacheAccountIdsAndRefs(account_ids, pubkeys) {
		account_ids.forEach((id, index)=>{
			var ref = Immutable.Set(id[0] ? [id[0]] : []);
			if(!this.get_account_refs_of_keys_calls.has(pubkeys[index])){
				this.get_account_refs_of_keys_calls = this.get_account_refs_of_keys_calls.add(pubkeys[index]); 
			}
			this.account_ids_by_key = this.account_ids_by_key.set(pubkeys[index], ref);
		});

	}

	async getFirstAccountIdByKeys(keys, noNotify = false) {
		let account_ids = await this.getAccountsIdByKeys(keys);
		if(!noNotify) {
			this.notifySubscribers();
		}
		return account_ids.find(v=>v[0]) && account_ids.find(v=>v[0])[0];
	}
	
	/**
	 * @return a Set of balance ids that are claimable with the given address
	 * @return undefined if a query is pending and the set is not known at this time
	 * @return a empty Set if no items are found
	 *
	 * If this method returns undefined, then it will send a request to the server for
	 * the current state after which it will be subscribed to changes to this set.
	 */
	getBalanceObjects(address) {
		let current = this.balance_objects_by_address.get(address);
		if(current === undefined) {
			/** because balance objects are simply part of the genesis state, there is no need to worry about
			 * having to update them / merge them or index them in updateObject.
			 */
			this.balance_objects_by_address = this.balance_objects_by_address.set(address, Immutable.Set());
			Apis.instance().db_api().exec("get_balance_objects", [[address]]).then(balance_objects => {
				let set = new Set();
				for(let i = 0; i < balance_objects.length; ++i) {
					this._updateObject(balance_objects[i]);
					set.add(balance_objects[i].id);
				}
				this.balance_objects_by_address = this.balance_objects_by_address.set(address, Immutable.Set(set));
				this.notifySubscribers();
			}, error => {
				this.balance_objects_by_address = this.balance_objects_by_address.delete(address);
			});
		}
		return this.balance_objects_by_address.get(address);
	}
	
	/**
	 *  If there is not already a pending request to fetch this object, a new
	 *  request will be made.
	 *
	 *  @return null if the object does not exist,
	 *  @return undefined if the object might exist but is not in cache
	 *  @return the object if it does exist and is in our cache
	 * 	@return false if there is error to stop 'async' fetching (E.g: getObjectAsync)
	 */
	fetchObject(id, force = false) {
		if(typeof id !== 'string') {
			let result = [];
			for(let i = 0; i < id.length; ++i) result.push(this.fetchObject(id[i]));
			return result;
		}
		
		if(DEBUG) console.log("!!! fetchObject: ", id, this.subscribed, !this.subscribed && !force);
		if(!this.subscribed && !force) return undefined;
		
		if(DEBUG) console.log("maybe fetch object: ", id);
		if(!ChainValidation.is_object_id(id)) throw Error("argument is not an object id: " + id);
		
		if(id.substring(0, 4) == "1.2.") {
			// console.log('fetchObject', id);
			// console.log(id == '1.2.20');
			// if(id == '1.2.20')
			// 	throw new Error();
			return this.fetchFullAccount(id);
		}
		
		let result = this.objects_by_id.get(id);
		if(result === undefined) {
			// the fetch
			if(DEBUG) console.log("fetching object: ", id);
			this.objects_by_id = this.objects_by_id.set(id, true);
			Apis.instance().db_api().exec("get_objects", [[id]]).then(optional_objects => {
				//if(DEBUG) console.log('... optional_objects',optional_objects ? optional_objects[0].id : null)
				for(let i = 0; i < optional_objects.length; i++) {
					let optional_object = optional_objects[i];
					if(optional_object) this._updateObject(optional_object, true); else {
						this.objects_by_id = this.objects_by_id.set(id, null);
						this.notifySubscribers();
					}
				}
			}).catch(error => {
				console.log('!!! Chain API error', error);
				this.objects_by_id = this.objects_by_id.set(id, false);
				if(error 
					&& error.message 
					&& !error.message.includes("GRAPHENE_DB_MAX_INSTANCE_ID")
				) {
					setTimeout(()=>{
				// in the event of an error clear the pending state for id
				this.objects_by_id = this.objects_by_id.delete(id);
					}, 1000);	
				}
			});
		} else if(result === true) // then we are waiting a response
			return undefined;
		return result; // we have a response, return it
	}
	
	/**
	 *  @return null if no such account exists
	 *  @return undefined if such an account may exist, and fetch the the full account if not already pending
	 *  @return the account object if it does exist
	 */
	getAccount(name_or_id) {
		if(this.fetching_names_or_ids.has(name_or_id)) {
			return undefined; //fetching
		}
		if(!name_or_id) return null;
		
		if(typeof name_or_id === 'object') {
			if(name_or_id.id) return this.getAccount(name_or_id.id); else if(name_or_id.get) return this.getAccount(name_or_id.get('id')); else return undefined;
		}
		
		if(ChainValidation.is_object_id(name_or_id)) {
			let account = this.getObject(name_or_id);
			if(account === null) {
				return null;
			}
			if(account === undefined || account.get('name') === undefined) {
				return this.fetchFullAccount(name_or_id);
			}
			return account;
		} else if(ChainValidation.is_address(name_or_id)) {
			let account_id = this.accounts_by_address.get(name_or_id);
			if(account_id === null) return null; // already fetched and it wasn't found
			if(account_id === undefined) // then no query, fetch it
				return this.getAccountByAddress(name_or_id);
			return this.getObject(account_id); // return it
		} else if(ChainValidation.is_account_name(name_or_id, true)) {

			let account_id = this.accounts_by_name.get(name_or_id);
			if(account_id === null) return null; // already fetched and it wasn't found
			if(account_id === undefined) // then no query, fetch it
				return this.fetchFullAccount(name_or_id);
				
			return this.getObject(account_id); // return it
		}
		return null;
		// throw Error( `Argument is not an account name or id: ${name_or_id}` )
	}
	
	async getAddressByBlockParams(info) {
		let address = await Apis.instance().db_api().exec('get_address', [info.block, info.n]);
		info.address = address;
		return info;
	}
	
	async getAccountAsync(name_or_id) {
			let account = this.getAccount(name_or_id);

			if(account !== undefined) {
				return account;
			}
			await sleep(100);
			return await this.getAccountAsync(name_or_id);
	}
	
	getAccountByAddress(address) {
		if(!this.fetching_by_address.has(address) || Date.now() - this.fetching_by_address.get(address) > 5000) {
			this.fetching_by_address.set(address, Date.now());
			Apis.instance().db_api().exec("get_address_references", [[address]]).then(results => {
				if(results && results.length && results[0].length) {
					
					let accountID = results[0][0];
					this.accounts_by_address = this.accounts_by_address.set(address, accountID);
					let account = this.getObject(accountID);
					if(account === null) {
						return null;
					}
					if(account === undefined || account.get('name') === undefined) {
						return this.fetchFullAccount(accountID);
					}
					return account;
				}
			});
		}
		return undefined;
	}
	
	getAccountPromise(name_or_id) {
		return new Promise((success, fail) => {
			let account = this.getAccount(name_or_id);
			if(typeof account == 'undefined') {
				return setTimeout(() => {
					this.getAccountPromise(name_or_id)
						.then(account => success(account))
						.catch(err => fail(err));
				}, 100);
			}
			if(account)
				return success(account);
			fail("Account not found");
		});
	}
	
	/**
	 * This method will attempt to lookup witness by account_id.
	 * If witness doesn't exist it will return null, if witness is found it will return witness object,
	 * if it's not fetched yet it will return undefined.
	 * @param account_id - account id
	 */
	getWitnessById(account_id) {
		let witness_id = this.witness_by_account_id.get(account_id);
		if(witness_id === undefined) {
			this.fetchWitnessByAccount(account_id);
			return undefined;
		}
		return witness_id ? this.getObject(witness_id) : null;
	}
	
	/**
	 * This method will attempt to lookup committee member by account_id.
	 * If committee member doesn't exist it will return null, if committee member is found it will return committee member object,
	 * if it's not fetched yet it will return undefined.
	 * @param account_id - account id
	 */
	getCommitteeMemberById(account_id) {
		let cm_id = this.committee_by_account_id.get(account_id);
		if(cm_id === undefined) {
			this.fetchCommitteeMemberByAccount(account_id);
			return undefined;
		}
		return cm_id ? this.getObject(cm_id) : null;
	}
	
	/**
	 * Obsolete! Please use getWitnessById
	 * This method will attempt to lookup the account, and then query to see whether or not there is
	 * a witness for this account.  If the answer is known, it will return the witness_object, otherwise
	 * it will attempt to look it up and return null.   Once the lookup has completed on_update will
	 * be called.
	 *
	 * @param id_or_account may either be an account_id, a witness_id, or an account_name
	 */
	getWitness(id_or_account) {
		let account = this.getAccount(id_or_account);
		if(!account) return null;
		let account_id = account.get('id');
		
		let witness_id = this.witness_by_account_id.get(account_id);
		if(witness_id === undefined) this.fetchWitnessByAccount(account_id);
		return this.getObject(witness_id);
		
		if(ChainValidation.is_account_name(id_or_account, true) || id_or_account.substring(0, 4) == "1.2.") {
			let account = this.getAccount(id_or_account);
			if(!account) {
				this.lookupAccountByName(id_or_account).then(account => {
					if(!account) return null;
					
					let account_id = account.get('id');
					let witness_id = this.witness_by_account_id.get(account_id);
					if(ChainValidation.is_object_id(witness_id)) return this.getObject(witness_id, on_update);
					
					if(witness_id == undefined) this.fetchWitnessByAccount(account_id).then(witness => {
						this.witness_by_account_id.set(account_id, witness ? witness.get('id') : null);
						if(witness && on_update) on_update();
					});
				}, error => {
					let witness_id = this.witness_by_account_id.set(id_or_account, null);
				});
			} else {
				let account_id = account.get('id');
				let witness_id = this.witness_by_account_id.get(account_id);
				if(ChainValidation.is_object_id(witness_id)) return this.getObject(witness_id, on_update);
				
				if(witness_id == undefined) this.fetchWitnessByAccount(account_id).then(witness => {
					this.witness_by_account_id.set(account_id, witness ? witness.get('id') : null);
					if(witness && on_update) on_update();
				});
			}
			return null;
		}
		return null;
	}
	
	// Obsolete! Please use getCommitteeMemberById
	getCommitteeMember(id_or_account, on_update = null) {
		if(ChainValidation.is_account_name(id_or_account, true) || id_or_account.substring(0, 4) == "1.2.") {
			let account = this.getAccount(id_or_account);
			
			if(!account) {
				this.lookupAccountByName(id_or_account).then(account => {
					let account_id = account.get('id');
					let committee_id = this.committee_by_account_id.get(account_id);
					if(ChainValidation.is_object_id(committee_id)) return this.getObject(committee_id, on_update);
					
					if(committee_id == undefined) {
						this.fetchCommitteeMemberByAccount(account_id).then(committee => {
							this.committee_by_account_id.set(account_id, committee ? committee.get('id') : null);
							if(on_update && committee) on_update();
						});
					}
				}, error => {
					let witness_id = this.committee_by_account_id.set(id_or_account, null);
				});
			} else {
				let account_id = account.get('id');
				let committee_id = this.committee_by_account_id.get(account_id);
				if(ChainValidation.is_object_id(committee_id)) return this.getObject(committee_id, on_update);
				
				if(committee_id == undefined) {
					this.fetchCommitteeMemberByAccount(account_id).then(committee => {
						this.committee_by_account_id.set(account_id, committee ? committee.get('id') : null);
						if(on_update && committee) on_update();
					});
				}
			}
		}
		return null;
	}
	
	/**
	 *
	 * @return a promise with the witness object
	 */
	fetchWitnessByAccount(account_id) {
		return new Promise((resolve, reject) => {
			Apis.instance().db_api().exec("get_witness_by_account", [account_id]).then(optional_witness_object => {
				if(optional_witness_object) {
					this.witness_by_account_id = this.witness_by_account_id.set(optional_witness_object.witness_account, optional_witness_object.id);
					let witness_object = this._updateObject(optional_witness_object, true);
					resolve(witness_object);
				} else {
					this.witness_by_account_id = this.witness_by_account_id.set(account_id, null);
					this.notifySubscribers();
					resolve(null);
				}
			}, reject);
		});
	}
	
	/**
	 *
	 * @return a promise with the witness object
	 */
	fetchCommitteeMemberByAccount(account_id) {
		return new Promise((resolve, reject) => {
			Apis.instance().db_api().exec("get_committee_member_by_account", [account_id]).then(optional_committee_object => {
				if(optional_committee_object) {
					this.committee_by_account_id = this.committee_by_account_id.set(optional_committee_object.committee_member_account, optional_committee_object.id);
					let committee_object = this._updateObject(optional_committee_object, true);
					resolve(committee_object);
				} else {
					this.committee_by_account_id = this.committee_by_account_id.set(account_id, null);
					this.notifySubscribers();
					resolve(null);
				}
			}, reject);
		});
	}
	
	/**
	 *  Fetches an account and all of its associated data in a single query
	 *
	 *  @param name_or_id account name or account id
	 *
	 *  @return undefined if the account in question is in the process of being fetched
	 *  @return the object if it has already been fetched
	 *  @return null if the object has been queried and was not found
	 */
	fetchFullAccount(name_or_id) {
		if(DEBUG) console.log("Fetch full account: ", name_or_id);
		
		let fetch_account = false;
		if(ChainValidation.is_object_id(name_or_id)) {
			let current = this.objects_by_id.get(name_or_id);
			fetch_account = current === undefined;
			if(!fetch_account && fetch_account.get('name')) {
				return current;
			}
		} else {
			if(!ChainValidation.is_account_name(name_or_id, true)) throw Error("argument is not an account name: " + name_or_id);
			
			let account_id = this.accounts_by_name.get(name_or_id);
			if(ChainValidation.is_object_id(account_id)) return this.getAccount(account_id);
		}
		
		/// only fetch once every 5 seconds if it wasn't found
		if(!this.fetching_get_full_accounts.has(name_or_id) || Date.now() - this.fetching_get_full_accounts.get(name_or_id) > 5000) {
			this.fetching_get_full_accounts.set(name_or_id, Date.now());
			//console.log( "FETCHING FULL ACCOUNT: ", name_or_id )

			this.fetching_names_or_ids.add(name_or_id); //setting fetch status to not do additional requests
			Apis.instance().db_api().exec("get_full_accounts", [[name_or_id], true]).then(results => {
				if(results.length === 0) {
					if(ChainValidation.is_object_id(name_or_id)) {
						this.objects_by_id = this.objects_by_id.set(name_or_id, null);
						this.notifySubscribers();
						return;
					}
					this.accounts_by_name = this.accounts_by_name.set(name_or_id, null);
					return;
				}
				let full_account = results[0][1];
				if(DEBUG) console.log("full_account: ", full_account);
				
				let {
					account,
					vesting_balances,
					statistics,
					call_orders,
					limit_orders,
					referrer_name, registrar_name, lifetime_referrer_name,
					votes,
					proposals
				} = full_account;
				
				this.accounts_by_name = this.accounts_by_name.set(account.name, account.id);
				account.referrer_name = referrer_name;
				account.lifetime_referrer_name = lifetime_referrer_name;
				account.registrar_name = registrar_name;
				account.balances = {};
				account.orders = new Immutable.Set();
				account.vesting_balances = new Immutable.Set();
				account.balances = new Immutable.Map();
				account.call_orders = new Immutable.Set();
				account.proposals = new Immutable.Set();
				account.vesting_balances = account.vesting_balances.withMutations(set => {
					vesting_balances.forEach(vb => {
						this._updateObject(vb, false);
						set.add(vb.id);
					});
				});
				
				votes.forEach(v => this._updateObject(v, false));
				
				account.balances = account.balances.withMutations(map => {
					full_account.balances.forEach(b => {
						this._updateObject(b, false);
						map.set(b.asset_type, b.id);
					});
				});
				
				account.orders = account.orders.withMutations(set => {
					limit_orders.forEach(order => {
						this._updateObject(order, false);
						set.add(order.id);
					});
				});
				
				account.call_orders = account.call_orders.withMutations(set => {
					call_orders.forEach(co => {
						this._updateObject(co, false);
						set.add(co.id);
					});
				});
				
				account.proposals = account.proposals.withMutations(set => {
					proposals.forEach(p => {
						this._updateObject(p, false);
						set.add(p.id);
					});
				});
				
				this._updateObject(statistics, false);
				let updated_account = this._updateObject(account, false);
				this.fetchRecentHistory(updated_account);
				this.notifySubscribers();
			}, error => {
				console.log("Error: ", error);
			
				if(ChainValidation.is_object_id(name_or_id)) {
					this.objects_by_id = this.objects_by_id.set(name_or_id, null);
					this.notifySubscribers();
					setTimeout(()=>{
						this.objects_by_id = this.objects_by_id.delete(id);
					}, 300)
					return;
				}
				this.accounts_by_name = this.accounts_by_name.set(name_or_id, null);
				setTimeout(()=>{
					this.accounts_by_name = this.accounts_by_name.delete(id);
				}, 300)
				return;
			}).finally(()=>{
					this.fetching_names_or_ids.delete(name_or_id);
			});
		}
		return undefined;
	}
	
	getAccountMemberStatus(account) {
		if(account === undefined) return undefined;
		if(account === null) return "unknown";
		if(account.get('lifetime_referrer') == account.get('id')) return "lifetime";
		let exp = new Date(account.get('membership_expiration_date')).getTime();
		let now = new Date().getTime();
		if(exp < now) return "basic";
		return "annual";
	}
	
	getAccountBalance(account, asset_type) {
		let balances = account.get('balances');
		if(!balances) return 0;
		
		let balance_obj_id = balances.get(asset_type);
		if(balance_obj_id) {
			let bal_obj = this.objects_by_id.get(balance_obj_id);
			if(bal_obj) return bal_obj.get('balance');
		}
		return 0;
	}
	
	/**
	 * There are two ways to extend the account history, add new more
	 * recent history, and extend historic hstory. This method will fetch
	 * the most recent account history and prepend it to the list of
	 * historic operations.
	 *
	 *  @param account immutable account object
	 *  @return a promise with the account history
	 */
	fetchRecentHistory(account, limit = 100) {
		// console.log( "get account history: ", account )
		/// TODO: make sure we do not submit a query if there is already one
		/// in flight...
		let account_id = account;
		if(!ChainValidation.is_object_id(account_id) && account.toJS) account_id = account.get('id');
		
		if(!ChainValidation.is_object_id(account_id)) return;
		
		account = this.objects_by_id.get(account_id);
		if(!account) return;
		
		let pending_request = this.account_history_requests.get(account_id);
		if(pending_request) {
			pending_request.requests++;
			return pending_request.promise;
		} else pending_request = {requests: 0};
		
		let most_recent = "1." + op_history + ".0";
		let history = account.get('history');
		
		if(history && history.size) most_recent = history.first().get('id');
		
		/// starting at 0 means start at NOW, set this to something other than 0
		/// to skip recent transactions and fetch the tail
		let start = "1." + op_history + ".0";
		
		pending_request.promise = new Promise((resolve, reject) => {
			// console.log('account_id', account_id);
			Apis.instance().history_api().exec("get_account_history", [account_id, most_recent, limit, start]).then(operations => {
				
				let current_account = this.objects_by_id.get(account_id);
				let current_history = current_account.get('history');
				if(!current_history) current_history = Immutable.List();
				let updated_history = Immutable.fromJS(operations);
				updated_history = updated_history.withMutations(list => {
					for(let i = 0; i < current_history.size; ++i) list.push(current_history.get(i));
				});
				let updated_account = current_account.set('history', updated_history);
				this.objects_by_id = this.objects_by_id.set(account_id, updated_account);
				
				//if( current_history != updated_history )
				//   this._notifyAccountSubscribers( account_id )
				
				let pending_request = this.account_history_requests.get(account_id);
				this.account_history_requests.delete(account_id);
				if(pending_request.requests > 0) {
					// it looks like some more history may have come in while we were
					// waiting on the result, lets fetch anything new before we resolve
					// this query.
					this.fetchRecentHistory(updated_account, limit).then(resolve, reject);
				} else resolve(updated_account);
			}); // end then
		});
		
		this.account_history_requests.set(account_id, pending_request);
		return pending_request.promise;
	}
	
	//_notifyAccountSubscribers( account_id )
	//{
	//   let sub = this.subscriptions_by_account.get( account_id )
	//   let acnt = this.objects_by_id.get(account_id)
	//   if( !sub ) return
	//   for( let item of sub.subscriptions )
	//      item( acnt )
	//}
	
	/**
	 *  Callback that receives notification of objects that have been
	 *  added, remove, or changed and are relevant to account_id
	 *
	 *  This method updates or removes objects from the main index and
	 *  then updates the account object with relevant meta-info depending
	 *  upon the type of account
	 */
	// _updateAccount( account_id, payload )
	// {
	//    let updates = payload[0]
	
	//    for( let i = 0; i < updates.length; ++i )
	//    {
	//       let update = updates[i]
	//       if( typeof update  == 'string' )
	//       {
	//          let old_obj = this._removeObject( update )
	
	//          if( update.search( order_prefix ) == 0 )
	//          {
	//                acnt = acnt.setIn( ['orders'], set => set.delete(update) )
	//          }
	//          else if( update.search( vesting_balance_prefix ) == 0 )
	//          {
	//                acnt = acnt.setIn( ['vesting_balances'], set => set.delete(update) )
	//          }
	//       }
	//       else
	//       {
	//          let updated_obj = this._updateObject( update )
	//          if( update.id.search( balance_prefix ) == 0 )
	//          {
	//             if( update.owner == account_id )
	//                acnt = acnt.setIn( ['balances'], map => map.set(update.asset_type,update.id) )
	//          }
	//          else if( update.id.search( order_prefix ) == 0 )
	//          {
	//             if( update.owner == account_id )
	//                acnt = acnt.setIn( ['orders'], set => set.add(update.id) )
	//          }
	//          else if( update.id.search( vesting_balance_prefix ) == 0 )
	//          {
	//             if( update.owner == account_id )
	//                acnt = acnt.setIn( ['vesting_balances'], set => set.add(update.id) )
	//          }
	
	//          this.objects_by_id = this.objects_by_id.set( acnt.id, acnt )
	//       }
	//    }
	//    this.fetchRecentHistory( acnt )
	// }
	
	/**
	 *  Updates the object in place by only merging the set
	 *  properties of object.
	 *
	 *  This method will create an immutable object with the given ID if
	 *  it does not already exist.
	 *
	 *  This is a "private" method called when data is received from the
	 *  server and should not be used by others.
	 *
	 *  @pre object.id must be a valid object ID
	 *  @return an Immutable constructed from object and deep merged with the current state
	 */
	_updateObject(object, notify_subscribers, emit = true) {
		if(!("id" in object)) {
			console.log("object with no id:", object);
			if("balance" in object && "owner" in object && "settlement_date" in object) {
				// Settle order object
				emitter.emit("settle-order-update", object);
			}
			return;
		}
		// if (!(object.id.split(".")[0] == 2) && !(object.id.split(".")[1] == 6)) {
		//   console.log( "update: ", object )
		// }
		
		// DYNAMIC GLOBAL OBJECT
		if(object.id == "2.1.0") {
			object.participation = 100 * (BigInteger(object.recent_slots_filled).bitCount() / 128.0);
			this.head_block_time_string = object.time;
			this.chain_time_offset.push(Date.now() - timeStringToDate(object.time).getTime());
			if(this.chain_time_offset.length > 10) this.chain_time_offset.shift(); // remove first
		}
		
		// NEW BLOCK
		if(object.block_id) {
			this.newBlock(object.block_id)
		}
		
		let current = this.objects_by_id.get(object.id);
		if(!current)
			current = Immutable.Map();
		let prior = current;
		if(current === undefined || current === true) {
			this.objects_by_id = this.objects_by_id.set(object.id, current = Immutable.fromJS(object));
		} else {
			this.objects_by_id = this.objects_by_id.set(object.id, current = current.mergeDeep(Immutable.fromJS(object)));
		}
		
		// BALANCE OBJECT
		if(object.id.substring(0, balance_prefix.length) == balance_prefix) {
			let owner = this.objects_by_id.get(object.owner);
			if(owner === undefined || owner === null) {
				return;
				/*  This prevents the full account from being looked up later
				 owner = {id:object.owner, balances:{ } }
				 owner.balances[object.asset_type] = object.id
				 owner = Immutable.fromJS( owner )
				 */
			} else {
				let balances = owner.get("balances");
				if(!balances) owner = owner.set("balances", Immutable.Map());
				owner = owner.setIn(['balances', object.asset_type], object.id);
			}
			this.objects_by_id = this.objects_by_id.set(object.owner, owner);
		}
		// ACCOUNT STATS OBJECT
		else if(object.id.substring(0, account_stats_prefix.length) == account_stats_prefix) {
			// console.log( "HISTORY CHANGED" )
			let prior_most_recent_op = prior ? prior.get('most_recent_op') : "2.9.0";
			
			if (prior_most_recent_op != object.most_recent_op) {
				this.fetchRecentHistory(object.owner);
			}
			if(this.is_actual_history.get(object.owner)) {
				this.is_actual_history = this.is_actual_history.set(object.owner, false);
			}
			this.addTransaction(object.owner);
		}
		// WITNESS OBJECT
		else if(object.id.substring(0, witness_prefix.length) == witness_prefix) {
			this.witness_by_account_id.set(object.witness_account, object.id);
			this.objects_by_vote_id.set(object.vote_id, object.id);
		}
		// COMMITTEE MEMBER OBJECT
		else if(object.id.substring(0, committee_prefix.length) == committee_prefix) {
			this.committee_by_account_id.set(object.committee_member_account, object.id);
			this.objects_by_vote_id.set(object.vote_id, object.id);
		}
		// ACCOUNT OBJECT
		else if(object.id.substring(0, account_prefix.length) == account_prefix) {
			current = current.set('active', Immutable.fromJS(object.active));
			current = current.set('owner', Immutable.fromJS(object.owner));
			current = current.set('options', Immutable.fromJS(object.options));
			current = current.set('whitelisting_accounts', Immutable.fromJS(object.whitelisting_accounts));
			current = current.set('blacklisting_accounts', Immutable.fromJS(object.blacklisting_accounts));
			current = current.set('whitelisted_accounts', Immutable.fromJS(object.whitelisted_accounts));
			current = current.set('blacklisted_accounts', Immutable.fromJS(object.blacklisted_accounts));
			this.objects_by_id = this.objects_by_id.set(object.id, current);
			// this.accounts_by_name = this.accounts_by_name.set(object.name, object.id);
		}
		// ASSET OBJECT
		else if(object.id.substring(0, asset_prefix.length) == asset_prefix) {
			this.assets_by_symbol = this.assets_by_symbol.set(object.symbol, object.id);
			let dynamic = current.get('dynamic');
			if(!dynamic) {
				let dad = this.getObject(object.dynamic_asset_data_id, true);
				if(!dad) dad = Immutable.Map();
				if(!dad.get('asset_id')) {
					dad = dad.set('asset_id', object.id);
				}
				this.objects_by_id = this.objects_by_id.set(object.dynamic_asset_data_id, dad);
				
				current = current.set('dynamic', dad);
				this.objects_by_id = this.objects_by_id.set(object.id, current);
			}
			
			let bitasset = current.get('bitasset');
			if(!bitasset && object.bitasset_data_id) {
				let bad = this.getObject(object.bitasset_data_id, true);
				if(!bad) bad = Immutable.Map();
				
				if(!bad.get('asset_id')) {
					bad = bad.set('asset_id', object.id);
				}
				this.objects_by_id = this.objects_by_id.set(object.bitasset_data_id, bad);
				
				current = current.set('bitasset', bad);
				this.objects_by_id = this.objects_by_id.set(object.id, current);
			}
		}
		// ASSET DYNAMIC DATA OBJECT
		else if(object.id.substring(0, asset_dynamic_data_prefix.length) == asset_dynamic_data_prefix) {
			// let asset_id = asset_prefix + object.id.substring( asset_dynamic_data_prefix.length )
			let asset_id = current.get("asset_id");
			if(asset_id) {
				let asset_obj = this.getObject(asset_id);
				if(asset_obj && asset_obj.set) {
					asset_obj = asset_obj.set('dynamic', current);
					this.objects_by_id = this.objects_by_id.set(asset_id, asset_obj);
				}
			}
		}
		// WORKER OBJECT
		else if(object.id.substring(0, worker_prefix.length) == worker_prefix) {
			this.objects_by_vote_id.set(object.vote_for, object.id);
			this.objects_by_vote_id.set(object.vote_against, object.id);
		}
		// BITASSET DATA OBJECT
		else if(object.id.substring(0, bitasset_data_prefix.length) == bitasset_data_prefix) {
			let asset_id = current.get("asset_id");
			if(asset_id) {
				let asset = this.getObject(asset_id);
				if(asset) {
					asset = asset.set("bitasset", current);
					emitter.emit('bitasset-update', asset);
					this.objects_by_id = this.objects_by_id.set(asset_id, asset);
				}
			}
		}
		// CALL ORDER OBJECT
		else if(object.id.substring(0, call_order_prefix.length) == call_order_prefix) {
			// Update nested call_orders inside account object
			if(emit) {
				emitter.emit("call-order-update", object);
			}
			
			let account = this.objects_by_id.get(object.borrower);
			if(account && account.has("call_orders")) {
				let call_orders = account.get("call_orders");
				if(!call_orders.has(object.id)) {
					account = account.set("call_orders", call_orders.add(object.id));
					this.objects_by_id = this.objects_by_id.set(account.get("id"), account);
				}
			}
		}
		// LIMIT ORDER OBJECT
		else if(object.id.substring(0, order_prefix.length) == order_prefix) {
			let account = this.objects_by_id.get(object.seller);
			if(account && account.has("orders")) {
				let limit_orders = account.get("orders");
				if(!limit_orders.has(object.id)) {
					account = account.set("orders", limit_orders.add(object.id));
					this.objects_by_id = this.objects_by_id.set(account.get("id"), account);
				}
			}
			// POROPOSAL OBJECT
		} else if(object.id.substring(0, proposal_prefix.length) == proposal_prefix) {
			this.addProposalData(object.required_active_approvals, object.id);
			this.addProposalData(object.required_owner_approvals, object.id);
		}
		
		if(notify_subscribers) this.notifySubscribers();
		
		return current;
	}
	
	getObjectsByVoteIds(vote_ids) {
		let result = [];
		let missing = [];
		for(let i = 0; i < vote_ids.length; ++i) {
			let obj = this.objects_by_vote_id.get(vote_ids[i]);
			if(obj) result.push(this.getObject(obj)); else {
				result.push(null);
				missing.push(vote_ids[i]);
			}
		}
		
		if(missing.length) {
			// we may need to fetch some objects
			Apis.instance().db_api().exec("lookup_vote_ids", [missing]).then(vote_obj_array => {
				console.log("missing ===========> ", missing);
				console.log("vote objects ===========> ", vote_obj_array);
				for(let i = 0; i < vote_obj_array.length; ++i) {
					if(vote_obj_array[i]) {
						this._updateObject(vote_obj_array[i]);
					}
				}
			}, error => console.log("Error looking up vote ids: ", error));
		}
		return result;
	}
	
	getObjectByVoteID(vote_id) {
		let obj_id = this.objects_by_vote_id.get(vote_id);
		if(obj_id) return this.getObject(obj_id);
		return undefined;
	}
	
	getHeadBlockDate() {
		return timeStringToDate(this.head_block_time_string);
	}
	
	getEstimatedChainTimeOffset() {
		if(this.chain_time_offset.length === 0) return 0;
		// Immutable is fast, sorts numbers correctly, and leaves the original unmodified
		// This will fix itself if the user changes their clock
		var median_offset = Immutable.List(this.chain_time_offset).sort().get(Math.floor((this.chain_time_offset.length - 1) / 2));
		// console.log("median_offset", median_offset)
		return median_offset;
	}
	
	addProposalData(approvals, objectId) {
		approvals.forEach(id => {
			let impactedAccount = this.objects_by_id.get(id);
			if(impactedAccount) {
				let proposals = impactedAccount.get("proposals");
				
				if(!proposals.includes(objectId)) {
					proposals = proposals.add(objectId);
					impactedAccount = impactedAccount.set("proposals", proposals);
					this._updateObject(impactedAccount.toJS(), false);
				}
			}
		});
	}
	
	getNextMaintenanceMoment() {
		let time = moment.utc().hours(9).minutes(0).second(0);
		if(time.diff(moment.utc(), 'seconds') < 0) {
			time.add(1, 'day');
		}
		return time;
	}
	
	async getObjectAsync(object_id) {
		let object = this.getObject(object_id);
		if(object === false) {
			return false;
		}
		if(object !== undefined) {
			return object;
		}
		await sleep(100);
		return await this.getObjectAsync(object_id);
	}
	
	async getMiningInfo(account_id, asset_id = '1.3.1') {
		return {
			matureBalance: await this.getMatureBalance(account_id, asset_id),
			requireTransferIndicator: await this.getIsExistRequireTransfer(account_id, asset_id)
		};
	}
	
	async getMatureBalance(account_id, asset_id = '1.3.1') {
		let history = (await this.getTransfers(account_id, asset_id)).toJS(),
			account = await this.getObjectAsync(account_id),
			asset = await this.getObjectAsync(asset_id);
		
		let precision = Math.pow(10, asset.get('precision'));
		if(!account || !account.get('balances') || !account.get('balances').get(asset_id)) {
			return {balance: 0, precision};
		}
		let balance = +(await this.getObjectAsync(account.get('balances').get(asset_id))).get('balance');

		let prevMaintenanceMoment = this.getNextMaintenanceMoment().subtract(1, 'day'),
			debitTxsForPeriod = [],
			validTxs = [];
		
		history.forEach(tx => {
			// Older than current mining period
			if(moment.utc(tx.block_time).diff(prevMaintenanceMoment, 'seconds') < 0) return;
			validTxs.push(tx);
			
			let txAmount = tx.op[1]['amount']['amount'];
			if(tx.op[1]['to'] == account_id) {
				balance -= txAmount;
			} else {
				txAmount += tx.op[1]['fee']['amount'];
				balance += txAmount;
			}
		});
		
		validTxs.reverse().forEach(tx => {
			let txAmount = tx.op[1]['amount']['amount'];
			
			if(tx.op[1]['to'] == account_id) {
				debitTxsForPeriod.push([txAmount, tx.block_time]);
			} else {
				txAmount += tx.op[1]['fee']['amount'];
				while(debitTxsForPeriod.length && txAmount > 0) {
					if(debitTxsForPeriod[debitTxsForPeriod.length - 1][0] > txAmount) {
						debitTxsForPeriod[debitTxsForPeriod.length - 1][0] -= txAmount;
						txAmount = 0;
					} else {
						txAmount -= debitTxsForPeriod[debitTxsForPeriod.length - 1][0];
						debitTxsForPeriod = debitTxsForPeriod.slice(0, -1);
					}
				}
				balance -= txAmount;
			}
		});
		
		debitTxsForPeriod.forEach(r => {
			let mature = 1440 - moment.utc(r[1]).diff(prevMaintenanceMoment, 'minutes');
			balance += r[0] * mature / 1440;
		});
		return {balance: Math.floor(balance), precision};
	}
	
	async getIsExistRequireTransfer(account_id, asset_id = '1.3.1') {
		if(this.account_sum_transfers_by_asset.has(account_id)) {
			return ((this.account_sum_transfers_by_asset.get(account_id).get(asset_id) || 0) >= 1000);
		}
		await this.setSumForMiningPeriod(account_id, asset_id);
		return await this.getIsExistRequireTransfer(account_id, asset_id);
	}
	
	async setSumForMiningPeriod(account_id, asset_id) {
		let history = (await this.getTransfers(account_id, asset_id)).toJS();
		let prevMaintenanceMoment = this.getNextMaintenanceMoment().subtract(1, 'day');
		let sum = 0;
		
		let assets = this.account_sum_transfers_by_asset.get(account_id);
		if(!assets) {
			assets = Immutable.Map();
		}
		
		history.forEach(tx => {
			// Older than current mining period
			if(moment.utc(tx.block_time).diff(prevMaintenanceMoment, 'seconds') < 0) return;
			
			if(tx.op[1]['to'] == account_id) return;
			sum += tx.op[1]['amount']['amount'];
		});
		assets = assets.set(asset_id, sum);
		this.account_sum_transfers_by_asset = this.account_sum_transfers_by_asset.set(account_id, assets);
	}
	
	async addTransaction(account_id) {
		if(this.fetching_transfers_by_account.get(account_id)) return;
		if(!this.transfers_by_account.has(account_id)) return;
		
		let ops = this.transfers_by_account.get(account_id).toJS();
		let lastID = 0;
		Object.keys(ops).forEach(asset_id => {
			let id = ops[asset_id][0]['id'].split('.')[2];
			if(id > lastID)
				lastID = id;
		});
		let transfers = await Apis.instance().history_api().exec('get_account_operation_history2', [
			account_id,
			'1.11.' + lastID,
			100,
			'1.11.0',
			0
		]);
		transfers.forEach(tx => {
			this._addTransferToHistory(account_id, tx, true);
			this.setSumForMiningPeriod(account_id, tx.op[1]['amount']['asset_id']);
		});
	}
	
	/**
	 *
	 * @param account_id
	 * @param asset_id - in null - return transfers for all assets
	 * @returns {Promise.<*>}
	 */
	async getTransfers(account_id, asset_id = '1.3.1') {
		if(this.fetching_transfers_by_account.get(account_id)) {
			await sleep(100);
			return await this.getTransfers(account_id, asset_id);
		}
		if(this.transfers_by_account.has(account_id)) {
			return this._getTransfersFromVar(account_id, asset_id);
			
		}
		this.fetching_transfers_by_account = this.fetching_transfers_by_account.set(account_id, true);
		this.transfers_by_account = this.transfers_by_account.set(account_id, Immutable.Map());
		this.all_transfers_by_account = this.all_transfers_by_account.set(account_id, Immutable.List());
		
		let transfers = await Apis.instance().history_api().exec('get_account_operation_history2', [
			account_id,
			'1.11.0',
			100,
			'1.11.0',
			0
		]);
		
		transfers.forEach(tx => this._addTransferToHistory(account_id, tx));
		this.fetching_transfers_by_account = this.fetching_transfers_by_account.set(account_id, false);
		return this._getTransfersFromVar(account_id, asset_id);
	}
	
	_getTransfersFromVar(account_id, asset_id) {
		if(asset_id)
			return this.transfers_by_account.get(account_id).get(asset_id) || Immutable.List();
		return this.all_transfers_by_account.get(account_id) || Immutable.List();
	}
	
	/**
	 * Add new transfer to this.transfers_by_account object
	 * @param account_id
	 * @param transfer
	 * @param prepend
	 * @private
	 */
	_addTransferToHistory(account_id, transfer, prepend = false) {
		let asset_id = transfer.op[1]['amount']['asset_id'];
		
		let assets = this.transfers_by_account.get(account_id);
		let allTransfers = this.all_transfers_by_account.get(account_id);
		
		let history = Immutable.List();
		if(this.transfers_by_account.has(account_id) && this.transfers_by_account.get(account_id).has(asset_id)) {
			history = this.transfers_by_account.get(account_id).get(asset_id);
		}
		if(prepend)
			history = history.unshift(transfer);
		else
			history = history.push(transfer);
		if(prepend)
			allTransfers = allTransfers.unshift(transfer);
		else
			allTransfers = allTransfers.push(transfer);
		assets = assets.set(asset_id, history);
		this.transfers_by_account = this.transfers_by_account.set(account_id, assets);
		this.all_transfers_by_account = this.all_transfers_by_account.set(account_id, allTransfers);
	}
	
	async getBlock(height) {
		if(this.blocks.has(height))
			return this.blocks.get(height);
		let block = await Apis.instance().db_api().exec('get_block', [height]);
		this.blocks = this.blocks.set(height, block);
		return block;
	}
	
	async newBlock(blockId) {
		let block = await Apis.instance().db_api().exec('get_block_by_id', [blockId]);
		this.blocks = this.blocks.set(block.block_number, block);
		this._clearOldBlock();
		return block;
	}
	
	_clearOldBlock() {
		let first = this.blocks.last();
		this.blocks = this.blocks.filter(block => {
			return block.block_number > first.block_number - 20;
		});
	}
}

/**
 *
 * @type {ChainStore}
 */
let chain_store = new ChainStore();

function FetchChainObjects(method, object_ids, timeout) {
	let get_object = method.bind(chain_store);
	
	return new Promise((resolve, reject) => {
		
		let timeout_handle = null;
		
		function onUpdate(not_subscribed_yet = false) {
			let res = object_ids.map(id => get_object(id));
			if(res.findIndex(o => o === undefined) === -1) {
				if(timeout_handle) clearTimeout(timeout_handle);
				if(!not_subscribed_yet) chain_store.unsubscribe(onUpdate);
				resolve(res);
				return true;
			}
			return false;
		}
		
		let resolved = onUpdate(true);
		if(!resolved) chain_store.subscribe(onUpdate);
		
		if(timeout && !resolved) timeout_handle = setTimeout(() => {
			chain_store.unsubscribe(onUpdate);
			reject("timeout");
		}, timeout);
	});
}

chain_store.FetchChainObjects = FetchChainObjects;

function FetchChain(methodName, objectIds, timeout = 1900) {
	
	let method = chain_store[methodName];
	if(!method) throw new Error("ChainStore does not have method " + methodName);
	
	let arrayIn = Array.isArray(objectIds);
	if(!arrayIn) objectIds = [objectIds];
	
	return chain_store.FetchChainObjects(method, Immutable.List(objectIds), timeout).then(res => arrayIn ? res : res.get(0));
}

chain_store.FetchChain = FetchChain;

function timeStringToDate(time_string) {
	if(!time_string) return new Date("1970-01-01T00:00:00.000Z");
	if(!/Z$/.test(time_string)) //does not end in Z
	// https://github.com/cryptonomex/graphene/issues/368
		time_string = time_string + "Z";
	return new Date(time_string);
}

function sleep(ms = 0) {
	return new Promise(r => setTimeout(r, ms));
}

module.exports = chain_store;