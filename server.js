// MyPhotoStorage-backend/server.js - 批次相簿管理核心 (MongoDB & Cloudflare R2 整合)
const mongoose = require('mongoose'); 
// 新增: 引入 path, os 和 fs
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const cors = require('cors'); 
// 引入 AWS S3 Client
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
// 新增: 引入 fluent-ffmpeg
// const ffmpeg = require('fluent-ffmpeg'); 
// 引入 node:stream (用於將 ffmpeg 輸出導向 R2)
// const { PassThrough } = require('node:stream');

// ⭐ 修正點 2.1: 引入 sharp 和 heic-convert 
// 解決 FFmpeg 無法處理 HEIC 的問題
const sharp = require('sharp'); 
const heicConvert = require('heic-convert'); 

const app = express();
app.use(cors()); 
app.use(express.json()); 

// ⭐ 關鍵修正：設定靜態檔案服務
// 將專案根目錄（包含 upload.html, upload.js, style.css, 和 ffmpeg_static）
// 設定為 Express 的靜態資源目錄。
app.use(express.static(path.join(__dirname, '')));

// 修正點 1: 使用 diskStorage 將檔案暫存到磁碟，避免記憶體溢出 (OOM)
const upload = multer({ 
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            // 使用作業系統的暫存目錄
            cb(null, os.tmpdir()); 
        },
        filename: function (req, file, cb) {
            // 生成唯一的暫存檔名
            cb(null, `${Date.now()}-${file.originalname.substring(0, 30)}`);
        }
    }),
    limits: {
        // 修正點 2: 設定檔案大小上限為 500MB (可依需求調整)
        fileSize: 500 * 1024 * 1024 // 500MB
    }
}); 

// 取得環境變數 - Cloudflare R2 專用
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_API_ENDPOINT = process.env.R2_API_ENDPOINT;     // S3 API 客戶端端點 (用於上傳/刪除)
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;       // 公用開發 URL (用於公開顯示)
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME; // 貯體名稱
const MONGODB_URL = process.env.MONGODB_URL; 

// 檢查所有 R2 變數
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_API_ENDPOINT || !R2_PUBLIC_URL || !R2_BUCKET_NAME || !MONGODB_URL) {
    console.error("❌ 錯誤：必要的環境變數缺失 (R2 或 MongoDB)");
    process.exit(1); 
}

// ----------------------------------------------------
// 1. 輔助函式 (Cloudflare R2 相關) - 在此處新增 R2 Client 初始化
// ----------------------------------------------------

// 實例化 S3 Client (用於連線 R2)
const s3Client = new S3Client({
    region: 'auto', // R2 建議使用 'auto'
    endpoint: R2_API_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    }
});

// ----------------------------------------------------
// 2. FFmpeg 額外設定 (保持相容性)
// ----------------------------------------------------
// 假設 FFmpeg 和 FFprobe 已經在 PATH 中 (由 install-ffmpeg.sh 完成)
// ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
// ffmpeg.setFfprobePath('/usr/bin/ffprobe');


// ----------------------------------------------------
// 3. MongoDB 連線與資料模型 (Schema) 定義
// ----------------------------------------------------

// 連線到 MongoDB
mongoose.connect(MONGODB_URL)
    .then(() => console.log('✅ MongoDB 連線成功'))
    .catch(err => console.error('❌ MongoDB 連線失敗:', err));

// 定義照片資料模型
const PhotoSchema = new mongoose.Schema({
    originalFileName: { type: String, required: true }, 
    storageFileName: { type: String, required: true, unique: true }, 
    githubUrl: { type: String, required: true }, 
    albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album' }, 
    uploadedAt: { type: Date, default: Date.now } 
});

// 定義相簿資料模型
const AlbumSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true }, 
    coverUrl: { type: String, default: '' }, 
    photoCount: { type: Number, default: 0 }, 
    createdAt: { type: Date, default: Date.now } 
});

const Photo = mongoose.model('Photo', PhotoSchema);
const Album = mongoose.model('Album', AlbumSchema);

// ----------------------------------------------------
// 4. 輔助函式 (Cloudflare R2 相關)
// ----------------------------------------------------

/**
 * 從 R2 刪除單個檔案
 */
async function deleteFileFromR2(storageFileName) {
    const params = {
        Bucket: R2_BUCKET_NAME,
        Key: `images/${storageFileName}`, 
    };
    
    await s3Client.send(new DeleteObjectCommand(params));
}

// ----------------------------------------------------
// 5. 輔助函式 - 媒體處理 (使用 sharp/heic-convert 和 FFmpeg)
// ----------------------------------------------------

/**
 * 使用 FFmpeg 或 sharp 處理媒體檔案 (壓縮影片/轉換 HEIC 到 JPEG)
 */
async function processMedia(file) {
    const originalPath = file.path;
    const originalMime = file.mimetype;
    const originalExt = path.extname(file.originalname).toLowerCase();
    
    // =========================================================================
    // 1. 優先檢查標準圖片格式 (確保它們跳過所有複雜邏輯)
    // =========================================================================
    if (
        originalMime === 'image/jpeg' || 
        originalMime === 'image/png' || 
        originalMime === 'image/webp' || 
        originalExt === '.jpg' ||
        originalExt === '.jpeg' ||
        originalExt === '.png' ||
        originalExt === '.webp' 
    ) {
        console.log(`🖼️ 偵測到標準圖片 (${originalMime})，跳過 FFmpeg 處理。`);
        // 直接使用原始檔案
        return { path: originalPath, mime: originalMime, ext: originalExt };
    }
    
    // =========================================================================
    // ⭐ 2. 修正點 2.2: 檢查是否為 HEIC 格式 (使用 sharp/heic-convert 轉換到 JPEG)
    // 解決 FFmpeg 編解碼器缺失問題
    // =========================================================================
    else if (
        originalMime === 'image/heic' || 
        originalMime === 'image/heif' || 
        originalMime === 'image/heic-sequence' || 
        originalMime === 'image/heif-sequence' || 
        originalExt === '.heic' || 
        originalExt === '.heif'
    ) {
        
        const outputExt = '.jpeg';
        const outputPath = path.join(os.tmpdir(), `${path.basename(originalPath)}-converted${outputExt}`);
        
        console.log('📸 偵測到 HEIC/HEIF 檔案，開始轉換為 JPEG (使用 sharp/heic-convert)');
        
        try {
            // 1. 讀取原始 HEIC 檔案內容 (Buffer)
            const inputBuffer = fs.readFileSync(originalPath);
            
            // 2. 轉換 HEIC Buffer 到 JPEG Buffer
            const jpegBuffer = await heicConvert({
                buffer: inputBuffer,
                format: 'JPEG', 
                quality: 0.9    
            });

            // 3. 寫入磁碟
            fs.writeFileSync(outputPath, jpegBuffer);
            
            console.log('✅ HEIC 轉換為 JPEG 完成');

        } catch (err) {
            console.error('❌ sharp/heic-convert 處理 HEIC 錯誤:', err.message);
            throw new Error(`HEIC 轉換失敗: ${err.message}`);
        }
        
        // 返回轉換後的檔案資訊
        return { path: outputPath, mime: 'image/jpeg', ext: outputExt };
        
    }

    // =========================================================================
    // 3. 檢查是否為影片檔案 (✅ 前端已處理，後端僅做直傳/跳過高負載運算)
    // =========================================================================
    else if (originalMime.startsWith('video/') || originalExt === '.mov' || originalExt === '.mp4' || originalExt === '.webm') {

    console.log(`🎬 偵測到影片檔案，假設已由前端壓縮，準備直傳。`);
    // 直接使用原始檔案
    return { path: originalPath, mime: originalMime, ext: originalExt };
}
    // =========================================================================
    // 3. 檢查是否為影片檔案 (FFmpeg 壓縮)
    // =========================================================================
    // else if (originalMime.startsWith('video/') || originalExt === '.mov' || originalExt === '.mp4') {

        // const outputExt = '.mp4';
        // const outputPath = path.join(os.tmpdir(), `${path.basename(originalPath)}-compressed${outputExt}`);

        // console.log(`🎬 偵測到影片，開始壓縮到 ${outputPath}`);
        
        // 影片壓縮邏輯
        // await new Promise((resolve, reject) => {
            // ffmpeg(originalPath)
                // .outputOptions([
                    // '-c:v libx264',
                    // '-preset ultrafast', // 極速預設
                    // '-crf 28', 
                    // '-pix_fmt yuv420p', 
                    // '-c:a aac',
                    // '-b:a 128k',
                    // '-movflags frag_keyframe+empty_moov'
                // ])
                // .on('timeout', (err) => { // 捕捉超時錯誤
                    // console.error('❌ FFmpeg 處理影片超時！');
                    // reject(new Error(`FFmpeg 處理影片超時！錯誤: ${err}`));
                // })
                // .on('end', () => {
                    // console.log('✅ 影片壓縮完成');
                    // resolve();
                // })
                // .on('error', (err) => {
                    // console.error('❌ FFmpeg 處理影片錯誤:', err.message);
                    // reject(new Error(`FFmpeg 處理影片失敗: ${err.message}`));
                // })
                // .save(outputPath);
        // });

        // 返回壓縮後的檔案資訊
        // return { path: outputPath, mime: 'video/mp4', ext: outputExt };
        //}

    
    // =========================================================================
    // 4. 其他檔案類型 (拋出錯誤)
    // =========================================================================
    throw new Error(`不支援的檔案類型: ${originalMime}`);
}

// ----------------------------------------------------
// 6. API 路由 - 相簿管理 (Albums)
// ----------------------------------------------------
// 健康檢查 API
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        message: 'MyPhotoStorage Backend Service is running and ready for API requests.'
    });
});
// [GET] 取得所有相簿列表
app.get('/api/albums', async (req, res) => {
    try {
        let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
        if (!defaultAlbum) {
            defaultAlbum = new Album({ name: '未分類相簿' });
            await defaultAlbum.save();
        }

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
        
        if (name === '未分類相簿') {
            return res.status(403).json({ error: '禁止將相簿名稱設定為「未分類相簿」' });
        }

        const album = await Album.findByIdAndUpdate(
            req.params.id, 
            { name: name, coverUrl: coverUrl }, 
            { new: true, runValidators: true } 
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

// [DELETE] 刪除相簿 (將照片轉移到 '未分類相簿')
app.delete('/api/albums/:id', async (req, res) => {
    try {
        const albumId = req.params.id;
        
        const albumToDelete = await Album.findById(albumId);
        if (!albumToDelete) {
            return res.status(404).json({ error: '找不到該相簿' });
        }
        
        if (albumToDelete.name === '未分類相簿') {
            return res.status(403).json({ error: '禁止刪除預設的「未分類相簿」' });
        }

        let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
        if (!defaultAlbum) {
            return res.status(500).json({ error: '系統錯誤：找不到預設相簿' });
        }

        // 1. 將該相簿下的所有照片轉移到 '未分類相簿'
        const updateResult = await Photo.updateMany(
            { albumId: albumId }, 
            { $set: { albumId: defaultAlbum._id } } 
        );
        
        // 2. 更新預設相簿的照片計數
        if (updateResult.modifiedCount > 0) {
            await Album.findByIdAndUpdate(defaultAlbum._id, { $inc: { photoCount: updateResult.modifiedCount } });
        }

        // 3. 刪除相簿本身
        await Album.findByIdAndDelete(albumId);

        res.json({ 
            message: `相簿「${albumToDelete.name}」已刪除，其中 ${updateResult.modifiedCount} 張照片已移至「未分類相簿」。`
        });
        
    } catch (error) {
        console.error('刪除相簿失敗:', error);
        res.status(500).json({ error: '無法刪除相簿' });
    }
});


// ----------------------------------------------------
// 7. API 路由 - 照片管理 (Photos)
// ----------------------------------------------------

// [GET] 取得特定相簿裡的所有照片
app.get('/api/albums/:id/photos', async (req, res) => {
    try {
        const albumId = req.params.id;
        // 確保相簿存在
        if (!(await Album.findById(albumId))) {
             return res.status(404).json({ error: '找不到該相簿' });
        }
        const photos = await Photo.find({ albumId: albumId }).sort({ uploadedAt: -1 });
        res.json(photos);
    } catch (error) {
        console.error('取得相簿照片失敗:', error);
        res.status(500).json({ error: '無法取得相簿照片' });
    }
});

// [PUT] 修改特定照片的名稱 (此功能在前端新分頁中未實作，但保留後端 API)
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

// [PATCH] 移動特定照片到其他相簿 (單張照片移動)
app.patch('/api/photos/:id/move', async (req, res) => {
    try {
        const { targetAlbumId } = req.body;
        const photoId = req.params.id;

        if (!targetAlbumId) {
            return res.status(400).json({ error: '請提供目標相簿 ID' });
        }
        
        const targetAlbum = await Album.findById(targetAlbumId);
        if (!targetAlbum) {
            return res.status(404).json({ error: '找不到目標相簿' });
        }
        
        const photo = await Photo.findById(photoId);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        const oldAlbumId = photo.albumId; 
        
        if (oldAlbumId && oldAlbumId.toString() === targetAlbumId) {
            return res.status(200).json({ message: '照片已在目標相簿中', photo: photo });
        }

        photo.albumId = targetAlbumId;
        await photo.save();

        // 更新新舊相簿的照片計數
        await Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -1 } }); 
        await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: 1 } }); 

        res.json({ message: '照片已成功移動', photo: photo });

    } catch (error) {
        console.error('移動照片失敗:', error);
        res.status(500).json({ error: '無法移動照片' });
    }
});

// [DELETE] 刪除單張照片
app.delete('/api/photos/:id', async (req, res) => {
    try {
        const photo = await Photo.findById(req.params.id);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        // 1. 從 R2 刪除檔案 (使用輔助函式)
        await deleteFileFromR2(photo.storageFileName); 
        
        // 2. 從 MongoDB 刪除記錄
        await Photo.findByIdAndDelete(req.params.id);
        
        // 3. 更新相簿計數
        if (photo.albumId) {
            await Album.findByIdAndUpdate(photo.albumId, { $inc: { photoCount: -1 } });
        }

        res.json({ message: '照片已成功刪除' });

    } catch (error) {
        const errorMessage = error.message; 
        console.error('刪除照片失敗:', errorMessage);
        res.status(500).json({ error: `無法刪除照片。錯誤訊息：${errorMessage}` });
    }
});


// ----------------------------------------------------
// 8. API 路由 - 批量照片操作 (新增部分，給前端 album-content.js 使用)
// ----------------------------------------------------

/**
 * [POST] 批量刪除照片 (DELETE /api/photos/bulkDelete) - 修正為循序執行
 */
app.post('/api/photos/bulkDelete', async (req, res) => {
    const { photoIds } = req.body;
    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        return res.status(400).json({ error: '請提供有效的照片 ID 列表進行批量刪除。' });
    }

    const successes = [];
    const failures = [];
    
    // 找出所有需要刪除的照片
    const photos = await Photo.find({ _id: { $in: photoIds } }).exec();
    
    // 關鍵修正：使用 for...of 迴圈確保循序執行
    for (const photo of photos) {
        try {
            // 1. 執行 R2 刪除
            await deleteFileFromR2(photo.storageFileName); 

            // 2. 刪除資料庫紀錄
            await Photo.deleteOne({ _id: photo._id });
            
            // 3. 更新所屬相簿的照片數量
            if (photo.albumId) {
                await Album.findByIdAndUpdate(photo.albumId, { $inc: { photoCount: -1 } });
            }

            successes.push(photo._id);
        } catch (error) {
            const errorMessage = error.message; 
            console.error(`刪除照片 ${photo._id} 失敗:`, errorMessage);
            
            failures.push({ 
                _id: photo._id, 
                error: `R2 刪除失敗: ${errorMessage}` 
            });
        }
    }

    if (successes.length === 0 && failures.length > 0) {
        // 如果全部失敗，回傳 500
        return res.status(500).json({
            error: `批量刪除請求失敗。成功 ${successes.length} 張，失敗 ${failures.length} 張。`,
            failures
        });
    }

    res.status(200).json({
        message: `批量刪除完成。成功刪除 ${successes.length} 張，失敗 ${failures.length} 張。`,
        successes,
        failures
    });
});


/**
 * [POST] 批量移動照片 (POST /api/photos/bulkMove)
 */
app.post('/api/photos/bulkMove', async (req, res) => {
    const { photoIds, targetAlbumId } = req.body;

    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0 || !targetAlbumId) {
        return res.status(400).json({ error: '請提供有效的照片 ID 列表和目標相簿 ID。' });
    }

    // 檢查目標相簿是否存在
    const targetAlbum = await Album.findById(targetAlbumId);
    if (!targetAlbum) {
        return res.status(404).json({ error: '找不到目標相簿。' });
    }

    const successes = [];
    const failures = [];
    
    try {
        // 1. 找出所有待移動照片的舊相簿 ID 
        const photos = await Photo.find({ _id: { $in: photoIds } }).select('albumId');
        if (photos.length === 0) {
            return res.status(404).json({ error: '找不到任何指定的照片。' });
        }
        
        // 2. 建立舊相簿計數變更地圖
        const oldAlbumUpdates = new Map();
        photos.forEach(photo => {
            const oldId = photo.albumId ? photo.albumId.toString() : 'null'; 
            
            // 避免將照片從 A 移動到 A
            if (oldId !== targetAlbumId.toString()) { 
                 oldAlbumUpdates.set(oldId, (oldAlbumUpdates.get(oldId) || 0) + 1);
            }
        });

        // 3. 在資料庫中執行批量更新操作 
        const updateResult = await Photo.updateMany(
            { _id: { $in: photoIds }, albumId: { $ne: targetAlbumId } }, 
            { $set: { albumId: targetAlbumId } }
        );
        
        const actualMovedCount = updateResult.modifiedCount;

        if (updateResult.acknowledged) {
            // 4. 更新舊相簿的 photoCount 
            const decrementPromises = [];
            for (const [oldAlbumId, count] of oldAlbumUpdates.entries()) {
                if (oldAlbumId !== targetAlbumId.toString()) { 
                     decrementPromises.push(
                        Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -count } })
                    );
                }
            }
            await Promise.allSettled(decrementPromises);

            // 5. 更新新相簿的 photoCount 
            if (actualMovedCount > 0) {
                 await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: actualMovedCount } });
            }
            
            photos.forEach(p => successes.push(p._id));
            
        } else {
            photoIds.forEach(id => failures.push({ _id: id, error: '資料庫更新失敗' }));
        }

    } catch (error) {
        console.error('批量移動照片失敗:', error);
        photoIds.forEach(id => failures.push({ _id: id, error: error.message }));
    }

    res.status(200).json({
        message: `批量移動完成。成功移動 ${successes.length} 張到「${targetAlbum.name}」。`,
        successes,
        failures
    });
});


// ----------------------------------------------------
// 9. API 路由 - 檔案上傳 (Upload) 
// ----------------------------------------------------

// 檔案上傳 API
app.post('/upload', upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }

    const { targetAlbumId } = req.body; 
    
    // 確保 defaultAlbum 存在且定義
    let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
    if (!defaultAlbum) {
        defaultAlbum = new Album({ name: '未分類相簿' });
        await defaultAlbum.save();
    }
    
    // ⭐ 修正點 1.1: 確保 targetAlbum 變數在迴圈外部被定義，解決 ReferenceError
    let targetAlbum = defaultAlbum; 
    
    if (targetAlbumId) {
        const foundAlbum = await Album.findById(targetAlbumId);
        if (foundAlbum) {
            targetAlbum = foundAlbum; 
        }
    }
    
    const results = [];
    let successCount = 0;
    
    for (const file of req.files) {
        
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');

        const filesToCleanup = [file.path]; 
        let processedMedia; 

        try {
            // 1. 呼叫 processMedia 取得處理後的結果
            processedMedia = await processMedia(file); 
            
            // 2. 判斷是否產生了新的暫存檔
            if (processedMedia.path !== file.path) {
                filesToCleanup.push(processedMedia.path);
            }
            
            // 3. 準備 R2 相關變數
            const rawFileName = `${Date.now()}-${baseName.replace(path.extname(baseName), processedMedia.ext)}`; 
            const fileKey = `images/${rawFileName}`; 
            
            // 4. 讀取處理後的磁碟檔案串流
            const fileStream = fs.createReadStream(processedMedia.path); 
            
            // 5. 構造 R2 上傳參數
            const uploadParams = {
                Bucket: R2_BUCKET_NAME,
                Key: fileKey,
                Body: fileStream, 
                ContentType: processedMedia.mime, 
                ACL: 'public-read', 
                // ⭐ 修正 3：加入 Cache-Control Header，設置為一年快取
                CacheControl: 'public, max-age=31536000, immutable' 
            };
            
            // 6. 執行 R2 上傳
            await s3Client.send(new PutObjectCommand(uploadParams));
            
            // 7. 構造 R2 公開 URL & 儲存 MongoDB 紀錄
            const r2PublicUrl = `${R2_PUBLIC_URL}/${fileKey}`; 

            const newPhoto = new Photo({
                originalFileName: originalnameFixed,
                storageFileName: rawFileName,
                githubUrl: r2PublicUrl, 
                albumId: targetAlbum._id // 這裡使用了確保定義的 targetAlbum
            });
            await newPhoto.save();
            
            successCount += 1; 
            results.push({
                status: 'success', 
                fileName: originalnameFixed, 
                url: r2PublicUrl
            });

        } catch (error) {
            // 錯誤處理
            const errorMessage = error.message;
            console.error(`處理/上傳 ${originalnameFixed} 失敗:`, errorMessage);
            results.push({
                status: 'error', 
                fileName: originalnameFixed,
                error: `媒體處理或 R2 上傳失敗。錯誤：${errorMessage}`
            });
        } finally {
            // 關鍵清理步驟
            for (const p of filesToCleanup) {
                 try {
                    if (fs.existsSync(p)) {
                        fs.unlinkSync(p);
                    }
                } catch (cleanupError) {
                    console.error(`刪除暫存檔 ${p} 失敗:`, cleanupError.message);
                }
            }
        }
    }

    if (successCount > 0) {
        // ⭐ 修正點 1.2: 確保 targetAlbum 存在，解決 ReferenceError
        if (targetAlbum) { 
            await Album.findByIdAndUpdate(targetAlbum._id, { $inc: { photoCount: successCount } });
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