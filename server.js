// MyPhotoStorage-backend/server.js - 解決 SHA 衝突的最終版本

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const cors = require('cors'); 

const app = express();
app.use(cors()); 

const upload = multer({ storage: multer.memoryStorage() }); 

// 取得環境變數
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.error("❌ 錯誤：必要的環境變數缺失！");
    process.exit(1);
}

app.post('/upload', upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }
    
    // ✨ 關鍵修復：使用 for...of 迴圈確保檔案依序上傳，避免 GitHub SHA 衝突
    const results = [];
    
    for (const file of req.files) {
        const fileBuffer = file.buffer;
        const contentBase64 = fileBuffer.toString('base64');
        
        // 【中文檔名修復】 修正 Multer 在處理非 ASCII 檔名時可能發生的編碼錯誤
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        // 確保檔名只包含英數字、連字號、點和中文字，其他變成底線
        const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');
        const rawFileName = `${Date.now()}-${baseName}`; 
        const filePath = `images/${rawFileName}`; // 存放在 images 資料夾中
        
        // 使用 encodeURIComponent 確保 API 網址中的中文路徑不會亂碼
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
        
        try {
            // 由於在 for...of 迴圈中，await 會等待上一個檔案完成才繼續
            const response = await axios.put(githubApiUrl, {
                message: `feat: Batch upload photo ${originalnameFixed}`, 
                content: contentBase64,
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });
            
            results.push({
                status: 'success', 
                fileName: originalnameFixed, 
                url: response.data.content.download_url
            });

        } catch (error) {
            const errorMessage = error.response ? error.response.data.message : error.message;
            console.error(`上傳 ${originalnameFixed} 失敗:`, errorMessage);
            results.push({
                status: 'error', 
                fileName: originalnameFixed,
                // 只回傳簡潔的錯誤提示，避免用戶看到 SHA 亂碼
                error: `上傳失敗，請稍後重試或檢查檔案大小。`
            });
        }
    } // 迴圈結束，所有檔案處理完成

    return res.json({ 
        message: `批次上傳完成，總計 ${results.length} 個檔案。`,
        results: results
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});