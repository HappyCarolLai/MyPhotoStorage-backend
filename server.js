// MyPhotoStorage-backend/server.js - 批次上傳版本

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

// ✨ 設定 API 接口：接收多個檔案 (photos)
app.post('/upload', upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }
    
    const uploadResults = [];
    const files = req.files;

    // 使用 Promise.all 同時處理多個檔案上傳
    const uploadPromises = files.map(async (file) => {
        const fileBuffer = file.buffer;
        const contentBase64 = fileBuffer.toString('base64');
        
        // 替照片取一個獨一無二的名字，並處理檔名特殊字元
        const safeFileName = file.originalname.replace(/[^a-z0-9\u4e00-\u9fa5\.]/gi, '_');
        const fileName = `${Date.now()}-${safeFileName}`;
        const filePath = `images/${fileName}`; // 存放在 images 資料夾中
        
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;
        
        try {
            const response = await axios.put(githubApiUrl, {
                message: `feat: Batch upload photo ${fileName}`,
                content: contentBase64,
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });
            
            return {
                status: 'success', 
                fileName: file.originalname,
                url: response.data.content.download_url
            };

        } catch (error) {
            const errorMessage = error.response ? error.response.data.message : error.message;
            console.error(`上傳 ${file.originalname} 失敗:`, errorMessage);
            return {
                status: 'error', 
                fileName: file.originalname,
                error: errorMessage
            };
        }
    });

    // 等待所有檔案上傳完成
    const results = await Promise.all(uploadPromises);
    
    return res.json({ 
        message: `批次上傳完成，總計 ${results.length} 個檔案。`,
        results: results
    });
});

// 設定伺服器要監聽的 Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});