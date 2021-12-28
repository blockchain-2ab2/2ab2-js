let assert = require('assert');
let {ChainConfig} = require('2ab2-ws-js');
let hash = require('./hash');
let {encode, decode} = require('bs58');
let deepEqual = require("deep-equal");

/** Addresses are shortened non-reversable hashes of a public key.  The full PublicKey is preferred.
    @deprecated
*/
class Address {

    constructor(addy) { this.addy = addy; }

    static fromBuffer(buffer) {
        let _hash = hash.sha512(buffer);
        let addy = hash.ripemd160(_hash);
        return new Address(addy);
    };

    static fromString(string, address_prefix = ChainConfig.address_prefix) {
        let prefix = string.slice(0, address_prefix.length);
        assert.equal(address_prefix, prefix, `Expecting key to begin with ${address_prefix}, instead got ${prefix}`);
        let addy = string.slice(address_prefix.length);
        addy = new Buffer(decode(addy), 'binary');
        let checksum = addy.slice(-4);
        addy = addy.slice(0, -4);
        let new_checksum = hash.ripemd160(addy);
        new_checksum = new_checksum.slice(0, 4);
        let isEqual = deepEqual(checksum, new_checksum); //, 'Invalid checksum'
        if (!isEqual) {
            throw new Error("Checksum did not match");
        }
        return new Address(addy);
    };
    
    static isAddress(string) {
    	try {
    		Address.fromString(string);
    		return true;
	    } catch(e) {
    		return false;
	    }
    }

    /** @return Address - Compressed PTS format (by default) */
    static fromPublic(public_key, compressed = true, version = 56) {
        let sha2 = hash.sha256(public_key.toBuffer(compressed));
        let rep = hash.ripemd160(sha2);
        let versionBuffer = new Buffer(1);
        versionBuffer.writeUInt8((0xFF & version), 0);
        let addr = Buffer.concat([versionBuffer, rep]);
        let check = hash.sha256(addr);
        check = hash.sha256(check);
        let buffer = Buffer.concat([addr, check.slice(0, 4)]);
        return new Address(hash.ripemd160(buffer));
    };

    toBuffer() {
        return this.addy;
    }

    toString(address_prefix = ChainConfig.address_prefix) {
        let checksum = hash.ripemd160(this.addy);
        let addy = Buffer.concat([this.addy, checksum.slice(0, 4)]);
        return address_prefix + encode(addy);
    }
}

module.exports = Address;
