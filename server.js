// MyPhotoStorage-backend/server.js - 最終中文檔名修復版本

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
    
    const uploadPromises = req.files.map(async (file) => {
        const fileBuffer = file.buffer;
        const contentBase64 = fileBuffer.toString('base64');
        
        // ✨ ✨ 【最終中文檔名修復】 ✨ ✨ 
        // 修正 Multer 在處理非 ASCII 檔名時可能發生的編碼錯誤
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        // 確保檔名只包含英數字、連字號、點和中文字，其他變成底線
        const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');
        const rawFileName = `${Date.now()}-${baseName}`; 
        const filePath = `images/${rawFileName}`; // 存放在 images 資料夾中
        
        // 使用 encodeURIComponent 確保 API 網址中的中文路徑不會亂碼
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
        
        try {
            const response = await axios.put(githubApiUrl, {
                message: `feat: Batch upload photo ${originalnameFixed}`, // 使用修正後的檔名
                content: contentBase64,
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });
            
            return {
                status: 'success', 
                fileName: originalnameFixed, // 回傳修正後的檔名
                url: response.data.content.download_url
            };

        } catch (error) {
            const errorMessage = error.response ? error.response.data.message : error.message;
            console.error(`上傳 ${originalnameFixed} 失敗:`, errorMessage);
            return {
                status: 'error', 
                fileName: originalnameFixed,
                error: errorMessage
            };
        }
    });

    const results = await Promise.all(uploadPromises);
    
    return res.json({ 
        message: `批次上傳完成，總計 ${results.length} 個檔案。`,
        results: results
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});