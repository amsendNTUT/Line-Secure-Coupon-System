const mongoose = require('mongoose');

//event schema
const campaignSchema = new mongoose.Schema({
    campaignId: {type: String, required: true, unique: true},
    title: {type: String, required: true},
    totalStock: {type: Number, required: true},
    remainingStock: {type: Number, required: true},
    expiresAt: {type: Date, required: true}
});


//coupon schema
const couponSchema = new mongoose.Schema({
    userId: {type: String, required: true},
    campaignId: {type: String, required: true},
    couponCode: {type: String, required: true, unique: true},
    nonce: {type: String, required: true, unique: true},
    status: {
        type: String, 
        enum: ['ISSUED', 'REDEEMED', 'EXPIRED'],
        default: 'ISSUED'
    },
    redeemedAt: {type: Date, default: null}
});

//safety protocal
couponSchema.index(
    {userId: 1, campaignId: 1},
    {unique: true}
);

module.exports = {
    Campaign: mongoose.model('Campaign', campaignSchema),
    Coupon: mongoose.model('Coupon', couponSchema)
};