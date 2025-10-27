import { Prop } from '@nestjs/mongoose';
import { Expose, Transform } from 'class-transformer';
import { ObjectId } from 'mongoose';

export class BaseEntity {
	_id?: ObjectId | string;

	@Expose()
	@Transform((value) => value.obj?._id?.toString(), { toClassOnly: true })
	id?: string;

	@Prop({default: true})
	isActive?: boolean;

	@Prop({ default: null })
	deletedAt?: Date;

	@Prop({ default: null })
	deletedBy?: string;

	@Prop({ default: null })
	createdBy?: string;

	@Prop({ default: null })
	updateBy?: string;

}
