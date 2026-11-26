require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const { Campaign, Coupon } = require('./models');

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Bot 設定
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 1. LINE Webhook 路由（必須放在 express.json() 之前以驗證簽章）
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
        await Promise.all(req.body.events.map(handleLineEvent));
        res.status(200).end();
    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).end();
    }
});

// 处理 LINE 訊息事件
async function handleLineEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return null;
    }

    const userId = event.source.userId;
    const text = event.message.text.trim();

    if (text.includes('領券') || text.includes('優惠券')) {
        // 呼叫內部的領券邏輯或直接引導開啟 LIFF 票券夾
        return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [
                {
                    type: 'flex',
                    altText: '🎟️ 您的 50 元專屬折價券已準備好！',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [
                                { type: 'text', text: '🎟️ 限量 50 元折價券', weight: 'bold', size: 'xl', color: '#06C755' },
                                { type: 'text', text: '點擊下方按鈕開啟專屬票券夾，系統將自動為您領取並產生防偽動態 QR Code。', wrap: true, margin: 'md', size: 'sm', color: '#666666' }
                            ]
                        },
                        footer: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [
                                {
                                    type: 'button',
                                    style: 'primary',
                                    color: '#06C755',
                                    action: {
                                        type: 'uri',
                                        label: '開啟我的票券夾',
                                        uri: process.env.LIFF_URL
                                    }
                                }
                            ]
                        }
                    }
                }
            ]
        });
    }

    return lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '請輸入「領券」來取得您的專屬優惠券！' }]
    });
}

// 2. 一般 API 的 JSON 解析與靜態網頁
app.use(express.json());
app.use(express.static('public'));

// 提供前端取得 LIFF_ID
app.get('/api/config', (req, res) => {
    res.json({ liffId: process.env.LIFF_ID });
});

// 查詢使用者已領取的票券（讓重複點開票券夾時能直接秀出原本的 QR Code）
app.get('/api/coupons/my', async (req, res) => {
    const { userId, campaignId } = req.query;
    if (!userId || !campaignId) {
        return res.status(400).json({ error: '缺少 userId 或 campaignId' });
    }
    try {
        const coupon = await Coupon.findOne({ userId, campaignId });
        if (!coupon) {
            return res.status(404).json({ error: '尚未領取票券' });
        }
        res.json({ coupon });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas!'))
    .catch(err => console.error('Connection fail: ', err));

// 建立活動
app.post('/api/seed', async (req, res) => {
    try {
        const campaign = await Campaign.findOneAndUpdate(
            { campaignId: 'LINE_COUP_50%OFF' },
            {
                title: '50 dollar coupon',
                totalStock: 100,
                remainingStock: 100,
                expiresAt: new Date('2026-12-31T23:59:59.000Z')
            },
            { upsert: true, new: true }
        );
        res.json({ message: 'Campaign Build', campaign });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 領券 API（防超賣 + 防重複領取）
app.post('/api/coupons/claim', async (req, res) => {
    const { userId, campaignId } = req.body;
    if (!userId || !campaignId) {
        return res.status(400).json({ error: 'userId / campaignId need' });
    }
    try {
        const campaign = await Campaign.findOneAndUpdate(
            {
                campaignId,
                remainingStock: { $gt: 0 },
                expiresAt: { $gt: new Date() }
            },
            { $inc: { remainingStock: -1 } },
            { new: true }
        );
        if (!campaign) {
            return res.status(400).json({ error: 'Campaign not found or out of stock or expired' });
        }
        const couponCode = crypto.randomBytes(16).toString('hex');
        const nonce = crypto.randomBytes(16).toString('hex');

        try {
            const coupon = await Coupon.create({
                userId,
                campaignId,
                couponCode,
                nonce,
                status: 'ISSUED'
            });
            res.status(201).json({ message: 'Coupon claimed successfully', coupon });
        } catch (dbErr) {
            await Campaign.updateOne({ campaignId }, { $inc: { remainingStock: 1 } });
            if (dbErr.code === 11000) {
                return res.status(409).json({ error: '您已經領取過此優惠券，請勿重複領取！' });
            }
            throw dbErr;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 核銷 API（防偽造 + 防重放攻擊）
app.post('/api/coupons/redeem', async (req, res) => {
    const { couponCode, nonce } = req.body;
    if (!couponCode || !nonce) {
        return res.status(400).json({ error: 'claim failed: couponCode and nonce required' });
    }
    try {
        const newNonce = crypto.randomBytes(16).toString('hex');
        const coupon = await Coupon.findOneAndUpdate(
            { couponCode, nonce, status: 'ISSUED' },
            {
                $set: {
                    status: 'REDEEMED',
                    redeemedAt: new Date(),
                    nonce: newNonce
                }
            },
            { returnDocument: 'after' }
        );
        if (!coupon) {
            return res.status(400).json({ error: '核銷失敗：票券無效、已使用或 QR Code 已過期！' });
        }
        res.json({ message: 'coupon claim success', coupon });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`server at http://localhost:${PORT} activated`);
});