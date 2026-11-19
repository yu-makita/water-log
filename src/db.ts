import Dexie,{type Table} from 'dexie';
export type Kind='small'|'large'|'both'|'water';
export type Category='water'|'caffeine'|'soup';
export type Entry={id?:number;kind:Kind;at:string;category?:Category;ml?:number;urge?:number;urineAmount?:string;stool?:number;stoolAmount?:string};
export type Shortcut={id?:number;label:string;category:Category;ml:number;order:number};
class LogDB extends Dexie{entries!:Table<Entry,number>;shortcuts!:Table<Shortcut,number>;constructor(){super('toilet-water-log');this.version(1).stores({entries:'++id,at,kind',shortcuts:'++id,order'});}}
export const db=new LogDB();
export const categories:Record<Category,string>={water:'水分',caffeine:'コーヒー紅茶',soup:'スープ類'};
export const kinds:Record<Kind,string>={small:'小',large:'大',both:'両方',water:'水分'};
export const localISO=(d=new Date())=>{const p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`};
export const day=(at:string)=>at.slice(0,10);
