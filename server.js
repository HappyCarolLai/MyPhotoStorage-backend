// MyPhotoStorage-backend/server.js - 相簿管理核心 (MongoDB 整合)

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors'); 
const mongoose = require('mongoose'); // 引入 MongoDB 連線工具

const app = express();
app.use(cors()); 
app.use(express.json()); // 讓 Express 可以解析 JSON 格式的請求 (用來新增相簿)

const upload = multer({ storage: multer.memoryStorage() }); 

// 取得環境變數
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const MONGODB_URL = process.env.MONGODB_URL; // MongoDB 連線字串

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !MONGODB_URL) {
    console.error("❌ 錯誤：必要的環境變數缺失 (GitHub 或 MongoDB)");
    // 為了安全，如果缺少關鍵變數，程式應停止運行
    process.exit(1); 
}

// ----------------------------------------------------
// 1. MongoDB 連線與資料模型 (Schema) 定義
// ----------------------------------------------------

// 連線到 MongoDB
mongoose.connect(MONGODB_URL)
    .then(() => console.log('✅ MongoDB 連線成功'))
    .catch(err => console.error('❌ MongoDB 連線失敗:', err));

// 定義照片資料模型 (記錄每一張上傳的照片資訊)
const PhotoSchema = new mongoose.Schema({
    originalFileName: { type: String, required: true }, // 原始檔名 (中文)
    storageFileName: { type: String, required: true, unique: true }, // GitHub 上儲存的檔名 (包含時間戳)
    githubUrl: { type: String, required: true }, // GitHub 圖片下載網址 (CDN 用)
    albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album' }, // 所屬相簿 ID
    uploadedAt: { type: Date, default: Date.now } // 上傳時間
});

// 定義相簿資料模型 (記錄相簿結構)
const AlbumSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true }, // 相簿名稱
    coverUrl: { type: String, default: '' }, // 相簿封面圖片網址 (圖片的 githubUrl)
    photoCount: { type: Number, default: 0 }, // 紀錄照片數量
    createdAt: { type: Date, default: Date.now } // 創建時間
});

const Photo = mongoose.model('Photo', PhotoSchema);
const Album = mongoose.model('Album', AlbumSchema);

// ----------------------------------------------------
// 2. API 路由 - 相簿管理 (Albums)
// ----------------------------------------------------

// [GET] 取得所有相簿列表
app.get('/api/albums', async (req, res) => {
    try {
        const albums = await Album.find().sort({ createdAt: -1 });
        res.json(albums);
    } catch (error) {
        console.error('取得相簿列表失敗:', error);
        res.status(500).json({ error: '無法取得相簿列表' });
    }
});

// [POST] 新增相簿
app.post('/api/albums', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: '相簿名稱不能為空' });
        }
        
        // 檢查名稱是否重複 (可選)
        const existingAlbum = await Album.findOne({ name });
        if (existingAlbum) {
             return res.status(409).json({ error: '相簿名稱已存在' });
        }
        
        const newAlbum = new Album({ name });
        await newAlbum.save();
        res.status(201).json(newAlbum);
    } catch (error) {
        console.error('新增相簿失敗:', error);
        res.status(500).json({ error: '無法新增相簿' });
    }
});

// [PUT] 修改相簿名稱或封面
app.put('/api/albums/:id', async (req, res) => {
    try {
        const { name, coverUrl } = req.body;
        if (!name) {
            return res.status(400).json({ error: '相簿名稱不能為空' });
        }

        const album = await Album.findByIdAndUpdate(
            req.params.id, 
            { name: name, coverUrl: coverUrl }, 
            { new: true, runValidators: true } // 返回更新後的文件並運行驗證器
        );

        if (!album) {
            return res.status(404).json({ error: '找不到該相簿' });
        }

        res.json(album);
    } catch (error) {
        console.error('更新相簿失敗:', error);
        res.status(500).json({ error: '無法更新相簿' });
    }
});

// [GET] 取得特定相簿裡的所有照片
app.get('/api/albums/:id/photos', async (req, res) => {
    try {
        const albumId = req.params.id;
        const photos = await Photo.find({ albumId: albumId }).sort({ uploadedAt: -1 });
        res.json(photos);
    } catch (error) {
        console.error('取得相簿照片失敗:', error);
        res.status(500).json({ error: '無法取得相簿照片' });
    }
});

// [PUT] 修改特定照片的名稱
app.put('/api/photos/:id', async (req, res) => {
    try {
        const { originalFileName } = req.body;
        if (!originalFileName) {
            return res.status(400).json({ error: '照片名稱不能為空' });
        }

        const photo = await Photo.findByIdAndUpdate(
            req.params.id, 
            { originalFileName: originalFileName }, 
            { new: true, runValidators: true }
        );

        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }

        res.json(photo);
    } catch (error) {
        console.error('更新照片名稱失敗:', error);
        res.status(500).json({ error: '無法更新照片名稱' });
    }
});


// ----------------------------------------------------
// 3. API 路由 - 檔案上傳 (Upload) - 包含寫入資料庫邏輯
// ----------------------------------------------------

// 檔案上傳 API
app.post('/upload', upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }

    // 預設將照片上傳到一個名為 '未分類相簿' 的相簿中 (如果不存在則創建)
    let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
    if (!defaultAlbum) {
        defaultAlbum = new Album({ name: '未分類相簿' });
        await defaultAlbum.save();
    }
    
    // 使用 for...of 迴圈確保檔案依序上傳，避免 GitHub SHA 衝突
    const results = [];
    
    for (const file of req.files) {
        // 中文檔名修復
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');
        const rawFileName = `${Date.now()}-${baseName}`; 
        const filePath = `images/${rawFileName}`; 
        
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
        
        try {
            // 步驟 A: 上傳檔案到 GitHub
            await axios.put(githubApiUrl, {
                message: `feat: Batch upload photo ${originalnameFixed}`, 
                content: file.buffer.toString('base64'),
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });
            
            // GitHub Raw 圖片網址 (用於前端顯示)
            const githubDownloadUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${filePath}`;

            // 步驟 B: 將照片資訊寫入 MongoDB
            const newPhoto = new Photo({
                originalFileName: originalnameFixed,
                storageFileName: rawFileName,
                githubUrl: githubDownloadUrl,
                albumId: defaultAlbum._id 
            });
            await newPhoto.save();

            // 步驟 C: 更新相簿照片數量 (計數器)
            defaultAlbum.photoCount += 1;
            await defaultAlbum.save();
            
            results.push({
                status: 'success', 
                fileName: originalnameFixed, 
                url: githubDownloadUrl
            });

        } catch (error) {
            const errorMessage = error.response ? error.response.data.message : error.message;
            console.error(`上傳 ${originalnameFixed} 失敗:`, errorMessage);
            results.push({
                status: 'error', 
                fileName: originalnameFixed,
                error: `上傳失敗，請稍後重試或檢查檔案大小。`
            });
        }
    } 

    return res.json({ 
        message: `批次上傳完成，總計 ${results.length} 個檔案。`,
        results: results
    });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});