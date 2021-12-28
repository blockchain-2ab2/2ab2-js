let ChainStore = require("./src/ChainStore.js");
let TransactionBuilder  = require("./src/TransactionBuilder.js");
/**
 *
 * @type {{ChainStore: (*|ChainStore), TransactionBuilder: TransactionBuilder, FetchChainObjects: (FetchChainObjects|*), ChainTypes, ObjectId: ObjectId, NumberUtils: *, TransactionHelper, ChainValidation, EmitterInstance: *, Login: (*|AccountLogin), FetchChain: (FetchChain|*)}}
 */
module.exports = {
    ChainStore: ChainStore,
    TransactionBuilder: TransactionBuilder,
    FetchChainObjects: ChainStore.FetchChainObjects,

    ChainTypes: require("./src/ChainTypes.js"),
    ObjectId: require("./src/ObjectId.js"),
    NumberUtils: require("./src/NumberUtils.js"),
    TransactionHelper: require("./src/TransactionHelper.js"),
    ChainValidation: require("./src/ChainValidation.js"),
    EmitterInstance: require("./src/EmitterInstance.js"),
    Login: require("./src/AccountLogin.js"),

    /** Helper function for FetchChainObjects */
    FetchChain: ChainStore.FetchChain
};
